/**
 * The voice library.
 *
 * This is the one part of the app that makes a claim about a *person* — "this is
 * Mara" — from a number. The measured gap it works in is not wide: on the test
 * fixtures the same person across recordings sits at 0.12–0.49 and different
 * people at 0.60 and up. So what is pinned here is mostly when it must refuse:
 * too far, too ambiguous, or two speakers competing for one name.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as voicesPlugin from '../src/voices.ts'
import { blend, distance } from '../src/voices.ts'
import * as asrPlugin from '../src/asr.ts'
import * as diarizePlugin from '../src/diarize.ts'
import * as speakersPlugin from '../src/speakers.ts'
import type { AsrEngine, Segment, TranscribeRequest, Transcript } from '../src/asr.ts'
import type { DiarizeEngine } from '../src/diarize.ts'

/** Unit vectors, so cosine distance is the only thing being measured. */
const unit = (...values: number[]): number[] => {
  const norm = Math.hypot(...values)
  return values.map((value) => value / norm)
}

const ALICE = unit(1, 0, 0)
const ALICE_AGAIN = unit(1, 0.25, 0) // ~0.03 away: the same voice, another day
const BOB = unit(0, 1, 0)

async function library(config: Partial<voicesPlugin.Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hexscribe-voices-'))
  const path = join(directory, 'voices.json')
  const ctx = new Context()
  await ctx.plugin(voicesPlugin, { path, threshold: 0.55, margin: 0.05, ...config })
  await ctx.voices.ready()
  return {
    ctx,
    path,
    dispose: async () => {
      await ctx.root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('distance is 0 for the same vector and 1 for an unrelated one', () => {
  assert.equal(distance(ALICE, ALICE), 0)
  assert.equal(distance(ALICE, BOB), 1)
  assert.equal(distance([1, 0], [1, 0, 0]), Infinity, 'different models cannot be compared')
})

test('a named voice is recognised in another recording', async (t) => {
  const app = await library()
  t.after(app.dispose)

  await app.ctx.voices.enroll('Alice', ALICE, 30)

  const match = await app.ctx.voices.match(ALICE_AGAIN)
  assert.equal(match?.name, 'Alice')
  assert.ok(match!.distance < 0.1, `expected a close match, got ${match?.distance}`)
})

test('a voice nobody named is not guessed at', async (t) => {
  const app = await library()
  t.after(app.dispose)

  assert.equal(await app.ctx.voices.match(ALICE), undefined, 'an empty library matches nothing')

  await app.ctx.voices.enroll('Alice', ALICE, 30)
  assert.equal(await app.ctx.voices.match(BOB), undefined, 'and a different voice stays unnamed')
})

test('an ambiguous match is no match, however close', async (t) => {
  // Two enrolled voices nearly equidistant from the candidate. The nearest is
  // within the threshold, so a naive rule would name it -- and be wrong half the
  // time. A confident wrong name is worse than a number.
  const app = await library()
  t.after(app.dispose)

  await app.ctx.voices.enroll('Alice', unit(1, 0.9, 0), 30)
  await app.ctx.voices.enroll('Bob', unit(0.9, 1, 0), 30)

  assert.equal(await app.ctx.voices.match(unit(1, 1, 0)), undefined)
})

test('enrolling the same person again improves the print instead of replacing it', async (t) => {
  const app = await library()
  t.after(app.dispose)

  const first = await app.ctx.voices.enroll('Alice', ALICE, 10)
  assert.equal(first.recordings, 1)
  assert.equal(first.seconds, 10)

  const second = await app.ctx.voices.enroll('Alice', ALICE_AGAIN, 30)
  assert.equal(second.recordings, 2)
  assert.equal(second.seconds, 40)
  assert.notDeepEqual(second.embedding, first.embedding, 'the print moved')
  assert.ok(
    distance(second.embedding, ALICE_AGAIN) < distance(first.embedding, ALICE_AGAIN),
    'and moved toward the recording that had more speech in it',
  )
  assert.ok(Math.abs(Math.hypot(...second.embedding) - 1) < 1e-9, 'staying a unit vector')

  const list = await app.ctx.voices.list()
  assert.equal(list.length, 1, 'one person, not two')
})

test('blending is weighted by how much speech is behind each side', () => {
  const mostlyAlice = blend({ name: 'a', embedding: ALICE, seconds: 100, recordings: 1 }, BOB, 1)
  assert.ok(distance(mostlyAlice, ALICE) < 0.01, 'one second does not move a 100-second print far')
})

test('names survive a restart, and forgetting is forgetting', async (t) => {
  const app = await library()
  t.after(app.dispose)

  await app.ctx.voices.enroll('Alice', ALICE, 30)

  // A second service over the same file: what the next run of the app sees.
  const reopened = new Context()
  await reopened.plugin(voicesPlugin, { path: app.path, threshold: 0.55, margin: 0.05 })
  await reopened.voices.ready()
  assert.equal((await reopened.voices.match(ALICE_AGAIN))?.name, 'Alice')

  assert.equal(await app.ctx.voices.forget('Alice'), true)
  assert.equal(await app.ctx.voices.match(ALICE), undefined)
  assert.equal(await app.ctx.voices.forget('Alice'), false, 'and says so when there was nothing')

  const onDisk = JSON.parse(await readFile(app.path, 'utf8'))
  assert.deepEqual(onDisk.voices, [], 'the file is the truth, not just the memory')
  await reopened.root.fiber.dispose()
})

test('a voice with no name is refused rather than stored blank', async (t) => {
  const app = await library()
  t.after(app.dispose)

  await assert.rejects(() => app.ctx.voices.enroll('   ', ALICE, 30), /needs a name/)
  await assert.rejects(() => app.ctx.voices.enroll('Alice', [], 30), /needs an embedding/)
})

// --- what the transcript ends up saying ---------------------------------

const segment = (index: number, start: number, end: number): Segment => ({
  index,
  start,
  end,
  text: `t${index}`,
})

function engines(ctx: Context) {
  const asr: AsrEngine = {
    name: 'mock',
    async describe() {
      return {}
    },
    async transcribe(request: TranscribeRequest): Promise<Transcript> {
      return {
        engine: 'mock',
        model: 'mock',
        language: request.language,
        segments: [segment(0, 0, 5), segment(1, 5, 10)],
        text: 't0 t1',
        timing: { audio_seconds: 10, total_ms: 1, rtf: 0 },
      }
    },
  }

  const diarizer: DiarizeEngine = {
    name: 'mock-diarizer',
    async describe() {
      return {}
    },
    async diarize() {
      return {
        engine: 'mock-diarizer',
        turns: [
          { start: 0, end: 5, speaker: 'SPEAKER_00' },
          { start: 5, end: 10, speaker: 'SPEAKER_01' },
        ],
        timing: { audio_seconds: 10, total_ms: 1, rtf: 0, turns: 2, speakers: 2 },
        profiles: [
          { speaker: 'SPEAKER_00', embedding: ALICE_AGAIN, seconds: 5, utterances: 1 },
          { speaker: 'SPEAKER_01', embedding: BOB, seconds: 5, utterances: 1 },
        ],
      }
    },
  }

  ctx.asr.register(asr)
  ctx.diarize.register(diarizer)
}

async function app(config: Partial<voicesPlugin.Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hexscribe-voices-'))
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'mock' })
  await ctx.plugin(diarizePlugin, {})
  await ctx.plugin(voicesPlugin, {
    path: join(directory, 'voices.json'),
    threshold: 0.55,
    margin: 0.05,
    ...config,
  })
  await ctx.plugin({ name: 'engines', inject: ['asr', 'diarize'], apply: engines })
  await ctx.plugin(speakersPlugin, {})
  await ctx.voices.ready()
  return {
    ctx,
    dispose: async () => {
      await ctx.root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('a recognised speaker is named everywhere they appear', async (t) => {
  const harness = await app()
  t.after(harness.dispose)

  await harness.ctx.voices.enroll('Alice', ALICE, 60)

  const result = await harness.ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true })

  assert.equal(result.segments[0].speaker, 'Alice', 'the label on the utterance')
  assert.equal(result.segments[1].speaker, 'SPEAKER_01', 'and the stranger keeps a number')
  assert.deepEqual(result.speakers, ['Alice', 'SPEAKER_01'])
  assert.equal(result.voices?.[0].speaker, 'Alice', 'the print follows the name')
  assert.equal(result.voices?.[0].matched?.name, 'Alice')
  assert.ok(result.voices?.[0].matched!.distance < 0.1)
  assert.equal(result.voices?.[1].matched, undefined)
})

test('one stored voice cannot be two speakers in the same recording', async (t) => {
  // Both speakers in this file are near the same enrolled print. Naming both
  // "Alice" would be certainly wrong for one of them, so the runner-up keeps
  // its number.
  const harness = await app({ threshold: 1.5, margin: 0 })
  t.after(harness.dispose)

  await harness.ctx.voices.enroll('Alice', ALICE, 60)

  const result = await harness.ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true })

  const named = result.segments.filter((entry) => entry.speaker === 'Alice')
  assert.equal(named.length, 1, 'exactly one speaker got the name')
})

test('without the library, speakers keep their numbers and nothing breaks', async (t) => {
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'mock' })
  await ctx.plugin(diarizePlugin, {})
  await ctx.plugin({ name: 'engines', inject: ['asr', 'diarize'], apply: engines })
  await ctx.plugin(speakersPlugin, {})
  t.after(() => ctx.root.fiber.dispose())

  const result = await ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true })

  assert.deepEqual(result.speakers, ['SPEAKER_00', 'SPEAKER_01'])
  assert.equal(result.voices?.length, 2, 'the prints are still carried, just unnamed')
  assert.equal(result.voices?.[0].matched, undefined)
})
