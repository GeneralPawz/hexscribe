/**
 * The routes that read and write what a person changed.
 *
 * Worth their own file because the bug they exist to stop is a shape mismatch
 * rather than a logic error: the page holds a transcript in OpenAI's *verbose*
 * shape — `duration`, an `id` per segment — and the database holds the engine's,
 * with `timing` and an `index`. Saving one where the other was expected stored a
 * transcript that could be written and never read: every later request for that
 * run answered 500, and the run looked lost.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as servePlugin from '../src/serve/index.ts'
import * as storePlugin from '../src/store.ts'
import * as storeHttpPlugin from '../src/store-http.ts'
import type { Run } from '../src/store.ts'

const withDefaults = <T,>(partial: Partial<T>): T => partial as T

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'hexscribe-store-http-'))
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'none' })
  await ctx.plugin(servePlugin, withDefaults<servePlugin.ServeConfig>({ host: '127.0.0.1', port: 0 }))
  await ctx.plugin(storePlugin, { path: join(directory, 'test.db') })
  await ctx.plugin(storeHttpPlugin)
  const url = await ctx.serve.ready()
  return {
    ctx,
    url,
    post: (path: string, payload: unknown) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    dispose: async () => {
      await ctx.root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const run = (id: string): Omit<Run, 'has_audio' | 'audio_bytes'> => ({
  id,
  name: `${id}.wav`,
  source: 'upload',
  path: null,
  source_path: null,
  status: 'done',
  created: 1,
  finished: 2,
  wall_ms: 2500,
  engine: 'qnn',
  model: 'whisper-small',
  language: 'en',
  task: 'transcribe',
  diarize: 1,
  merge: 1,
  audio_seconds: 30,
  segments: 2,
  speakers: 2,
  rtf: 0.08,
  error: null,
})

const transcript = () => ({
  engine: 'qnn',
  model: 'whisper-small',
  language: 'en',
  segments: [
    { index: 0, start: 0, end: 10, text: 'a', speaker: 'SPEAKER_00' },
    { index: 1, start: 10, end: 20, text: 'b', speaker: 'SPEAKER_01' },
  ],
  text: 'a b',
  timing: { audio_seconds: 30, total_ms: 2500, rtf: 0.08 },
})

test('an edited transcript comes back from the shape the page sent', async (t) => {
  const app = await harness()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  // Exactly what the browser holds: the verbose body it was given, edited.
  // Two lines merged into one, and the survivor moved to a named speaker.
  const edited = {
    task: 'transcribe',
    language: 'en',
    duration: 30,
    text: 'a b',
    speakers: ['Mara'],
    segments: [{ id: 0, start: 0, end: 20, text: 'a b', speaker: 'Mara' }],
  }
  const saved = await app.post('/v1/runs/transcript', { id: 'a', transcript: edited })
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), { saved: true, segments: 1, speakers: 1 })

  // And the run still answers, which is the whole point: storing the page's
  // shape lost `timing`, and every later read of that run threw a 500.
  const reread = await fetch(`${app.url}/v1/runs?id=a`)
  assert.equal(reread.status, 200)
  const body = (await reread.json()) as {
    transcript: { duration: number; segments: Array<{ id: number; text: string; speaker?: string }> }
    segments: number
  }
  assert.equal(body.transcript.duration, 30, 'how long the audio was is not the page to decide')
  assert.equal(body.transcript.segments.length, 1)
  assert.equal(body.transcript.segments[0].text, 'a b')
  assert.equal(body.transcript.segments[0].speaker, 'Mara')
  assert.equal(body.segments, 1, 'and the count the rail lists followed the edit')
})

test('saving a transcript for a run that is gone says so', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const answer = await app.post('/v1/runs/transcript', {
    id: 'nobody',
    transcript: { segments: [{ start: 0, end: 1, text: 'x' }] },
  })
  assert.equal(answer.status, 404)

  const empty = await app.post('/v1/runs/transcript', { id: 'a', transcript: {} })
  assert.equal(empty.status, 400, 'and a body without segments is not a transcript')
})

test('comments are written, edited and deleted over HTTP', async (t) => {
  const app = await harness()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  type Notes = { saved: number | false; notes: Array<{ id: number; body: string }> }
  const write = async (payload: Record<string, unknown>): Promise<Notes> =>
    (await (await app.post('/v1/notes', payload)).json()) as Notes

  const first = await write({ runId: 'a', start: 10, body: 'ask again' })
  const second = await write({ runId: 'a', start: 10, body: 'she hesitated' })
  assert.equal(second.notes.length, 2, 'a line holds more than one')

  const edited = await write({ runId: 'a', start: 10, body: 'ask again, gently', id: first.saved })
  assert.deepEqual(edited.notes.map((note) => note.body), ['ask again, gently', 'she hesitated'])

  const deleted = (await (
    await app.post('/v1/notes/delete', { runId: 'a', id: second.saved })
  ).json()) as Notes
  assert.deepEqual(deleted.notes.map((note) => note.body), ['ask again, gently'])
})

test('a speaker can be asked where else they were heard', async (t) => {
  const app = await harness()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveRun(run('b'), transcript())

  const answer = (await (await fetch(`${app.url}/v1/speakers/runs?name=SPEAKER_00`)).json()) as {
    runs: Array<{ id: string; utterances: number }>
  }
  assert.deepEqual(answer.runs.map((entry) => entry.id).sort(), ['a', 'b'])
  assert.equal(answer.runs[0].utterances, 1)

  const missing = await fetch(`${app.url}/v1/speakers/runs`)
  assert.equal(missing.status, 400, 'and it has to be asked about somebody')
})
