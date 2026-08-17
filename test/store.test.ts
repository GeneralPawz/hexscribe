/**
 * The database.
 *
 * This is the first thing in the project that is expected to still be here
 * tomorrow, which changes what can go wrong: not a wrong answer but a lost one,
 * or a deletion that leaves the thing it claimed to delete. So what is pinned is
 * mostly durability and removal — that a run survives a reopen, that deleting
 * one takes its transcript and audio with it, and that the danger zone's two
 * buttons differ in exactly the way their labels promise.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as storePlugin from '../src/store.ts'
import { DEFAULT_SETTINGS, defaultDataDirectory } from '../src/store.ts'
import type { Run } from '../src/store.ts'
import type { Transcript } from '../src/asr.ts'

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'hexscribe-store-'))
  const path = join(directory, 'test.db')
  const ctx = new Context()
  await ctx.plugin(storePlugin, { path })
  return {
    ctx,
    path,
    directory,
    dispose: async () => {
      await ctx.root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const transcript = (segments = 2): Transcript => ({
  engine: 'qnn',
  model: 'whisper-small',
  language: 'de',
  segments: Array.from({ length: segments }, (_, index) => ({
    index,
    start: index * 5,
    end: index * 5 + 5,
    text: `utterance ${index}`,
  })),
  text: 'utterance 0 utterance 1',
  timing: { audio_seconds: segments * 5, total_ms: 1000, rtf: 0.1 },
})

const run = (id: string, overrides: Partial<Run> = {}): Omit<Run, 'has_audio' | 'audio_bytes'> => ({
  id,
  name: `${id}.wav`,
  source: 'upload',
  path: null,
  status: 'done',
  created: Date.now(),
  finished: Date.now() + 1000,
  wall_ms: 1000,
  engine: 'qnn',
  model: 'whisper-small',
  language: 'de',
  task: 'transcribe',
  diarize: 0,
  merge: 1,
  audio_seconds: 10,
  segments: 2,
  speakers: 0,
  rtf: 0.1,
  error: null,
  ...overrides,
})

test('the data directory is where the platform keeps application data', () => {
  // Not next to the code: a checkout is a thing you delete and re-clone, and
  // the transcripts are not.
  const windows = defaultDataDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
  assert.match(windows, /AppData[\\/]Local[\\/]hexscribe$/)
  assert.doesNotMatch(windows, /Roaming/, 'audio blobs have no business syncing to a domain profile')

  assert.match(defaultDataDirectory('darwin', {}), /Library[\\/]Application Support[\\/]hexscribe$/)
  // Separator-agnostic: `join` normalises to whatever platform the *test* runs
  // on, which is not the platform being described.
  assert.match(defaultDataDirectory('linux', { XDG_DATA_HOME: '/home/x/.data' }), /home[\\/]x[\\/]\.data[\\/]hexscribe$/)
  assert.match(defaultDataDirectory('linux', {}), /\.local[\\/]share[\\/]hexscribe$/)
})

test('a run and its transcript survive the database being reopened', async (t) => {
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  await app.ctx.root.fiber.dispose()

  // A second service over the same file: what the next start of the app sees.
  // Closed here rather than in a hook, because the hook that removes the
  // directory would otherwise run while this still had the file open.
  const reopened = new Context()
  await reopened.plugin(storePlugin, { path: app.path })

  const found = reopened.store.getRun('a')
  assert.equal(found?.name, 'a.wav')
  assert.equal(found?.transcript?.segments.length, 2)
  assert.equal(found?.transcript?.segments[1].text, 'utterance 1')
  assert.equal(found?.rtf, 0.1)

  await reopened.root.fiber.dispose()
})

test('listing runs is cheap: newest first, and without the transcripts', async (t) => {
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('old', { created: 1000 }), transcript())
  app.ctx.store.saveRun(run('new', { created: 2000 }), transcript())

  const listed = app.ctx.store.listRuns()
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ['new', 'old'],
  )
  assert.ok(!('transcript' in listed[0]), 'a list of a hundred must not read a hundred transcripts')
  assert.equal(listed[0].has_audio, 0)
})

test('a failed run is recorded too, with what went wrong', async (t) => {
  // The reason logging is here at all: a run that failed is exactly the one a
  // person comes back to look at.
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('bad', { status: 'failed', error: 'InvalidDataError: bad packet', segments: 0 }))

  const found = app.ctx.store.getRun('bad')
  assert.equal(found?.status, 'failed')
  assert.match(found?.error ?? '', /InvalidDataError/)
  assert.equal(found?.transcript, undefined, 'and no transcript, because there is none')
})

test('deleting a run takes its transcript and audio with it', async (t) => {
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveAudio('a', 'audio/ogg', new Uint8Array([1, 2, 3, 4]), 4000)
  assert.equal(app.ctx.store.stats().audioClips, 1)

  assert.equal(app.ctx.store.deleteRun('a'), true)

  assert.equal(app.ctx.store.getRun('a'), undefined)
  assert.equal(app.ctx.store.getAudio('a'), undefined, 'leaving the audio would make the delete a lie')
  assert.equal(app.ctx.store.stats().transcripts, 0)
  assert.equal(app.ctx.store.deleteRun('a'), false, 'and says so when there was nothing')
})

test('the danger zone: clearing audio keeps the words', async (t) => {
  // The whole point of having two buttons. One forgets the recordings; the
  // other forgets everything.
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveRun(run('b'), transcript())
  app.ctx.store.saveAudio('a', 'audio/ogg', new Uint8Array(1024), 50_000)
  app.ctx.store.saveAudio('b', 'audio/ogg', new Uint8Array(2048), 90_000)

  assert.equal(app.ctx.store.clearAudio(), 2, 'reports how many it forgot')

  assert.equal(app.ctx.store.stats().audioClips, 0)
  assert.equal(app.ctx.store.stats().audioBytes, 0)
  assert.equal(app.ctx.store.stats().runs, 2, 'the runs are still there')
  assert.equal(app.ctx.store.getRun('a')?.transcript?.segments.length, 2, 'and so are the words')
  assert.equal(app.ctx.store.getRun('a')?.has_audio, 0, 'but they know the audio is gone')
})

test('the danger zone: resetting leaves nothing, including the settings', async (t) => {
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveAudio('a', 'audio/ogg', new Uint8Array(64), 100)
  app.ctx.store.log('error', 'something went wrong', 'a')
  app.ctx.store.saveSettings({ language: 'en' })

  app.ctx.store.reset()

  const stats = app.ctx.store.stats()
  assert.equal(stats.runs, 0)
  assert.equal(stats.transcripts, 0)
  assert.equal(stats.audioClips, 0)
  assert.equal(stats.logs, 0)
  assert.equal(app.ctx.store.settings().language, DEFAULT_SETTINGS.language, 'back to the defaults')
})

test('stats answer the question a person is actually asking', async (t) => {
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveAudio('a', 'audio/ogg', new Uint8Array(4096), 1_000_000)

  const stats = app.ctx.store.stats()
  assert.equal(stats.runs, 1)
  assert.equal(stats.audioClips, 1)
  assert.equal(stats.audioBytes, 4096)
  assert.ok(stats.fileBytes > 0, '"how big is it" means the file on disk')
  assert.equal(stats.path, app.path)
})

test('settings start as the defaults and only accept keys we own', async (t) => {
  const app = await store()
  t.after(app.dispose)

  assert.deepEqual(app.ctx.store.settings(), DEFAULT_SETTINGS)

  const saved = app.ctx.store.saveSettings({ language: 'en', diarize: true })
  assert.equal(saved.language, 'en')
  assert.equal(saved.diarize, true)
  assert.equal(saved.merge, DEFAULT_SETTINGS.merge, 'untouched keys keep their value')

  app.ctx.store.saveSettings({ nonsense: 1 } as never)
  assert.ok(!('nonsense' in app.ctx.store.settings()), 'an unknown key is not storage')
})

test('logs are kept newest first, and can be narrowed to one run', async (t) => {
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.log('info', 'started', 'a')
  app.ctx.store.log('error', 'exploded', 'a')
  app.ctx.store.log('warn', 'unrelated')

  const all = app.ctx.store.recentLogs()
  assert.equal(all.length, 3)
  assert.equal(all[0].message, 'unrelated', 'newest first')

  const mine = app.ctx.store.recentLogs(10, 'a')
  assert.deepEqual(
    mine.map((entry) => entry.message),
    ['exploded', 'started'],
  )
  assert.equal(mine[0].level, 'error')
})

test('a run can be repointed from stored audio to a file on disk', async (t) => {
  // What the panel does when someone drops the blob to save space but still
  // wants to click a timestamp and hear it.
  const app = await store()
  t.after(app.dispose)

  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveAudio('a', 'audio/ogg', new Uint8Array(128), 900)

  app.ctx.store.deleteAudio('a')
  assert.equal(app.ctx.store.setRunSource('a', 'disk', 'D:\\audio\\interview.mp3'), true)

  const found = app.ctx.store.getRun('a')
  assert.equal(found?.source, 'disk')
  assert.equal(found?.path, 'D:\\audio\\interview.mp3')
  assert.equal(found?.has_audio, 0)
})
