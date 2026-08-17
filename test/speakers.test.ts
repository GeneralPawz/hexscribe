/**
 * Speaker attribution.
 *
 * The rule is small and entirely consequential: whisper's utterances and
 * pyannote's turns are cut on different criteria, so every label is the result
 * of an overlap decision made here. These tests pin that decision, plus the way
 * a diarized transcript reaches each output format.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as diarizePlugin from '../src/diarize.ts'
import * as speakersPlugin from '../src/speakers.ts'
import { attribute, overlap } from '../src/speakers.ts'
import { renderSrt, renderText, renderVtt } from '../src/formats.ts'
import type { AsrEngine, Segment, TranscribeRequest, Transcript } from '../src/asr.ts'
import type { DiarizeEngine, DiarizeRequest, Turn } from '../src/diarize.ts'

const seg = (index: number, start: number, end: number, text = `t${index}`): Segment => ({
  index,
  start,
  end,
  text,
})
const turn = (start: number, end: number, speaker: string): Turn => ({ start, end, speaker })

// --- the rule ----------------------------------------------------------

test('overlap is the shared duration, never negative', () => {
  assert.equal(overlap({ start: 0, end: 10 }, { start: 5, end: 15 }), 5)
  assert.equal(overlap({ start: 0, end: 10 }, { start: 10, end: 20 }), 0)
  assert.equal(overlap({ start: 0, end: 1 }, { start: 5, end: 6 }), 0)
  assert.equal(overlap({ start: 2, end: 4 }, { start: 0, end: 10 }), 2)
})

test('an utterance takes the speaker it shares most time with', () => {
  const segments = [seg(0, 0, 10)]
  const turns = [turn(0, 3, 'SPEAKER_01'), turn(3, 10, 'SPEAKER_00')]

  assert.equal(attribute(segments, turns)[0].speaker, 'SPEAKER_00')
})

test('overlapping turns are summed per speaker, not counted once', () => {
  // Crosstalk: SPEAKER_01 speaks twice inside the window, 4 s total, against
  // SPEAKER_00's single 3 s stretch. Picking the longest single turn would be wrong.
  const segments = [seg(0, 0, 10)]
  const turns = [turn(0, 2, 'SPEAKER_01'), turn(2, 5, 'SPEAKER_00'), turn(5, 7, 'SPEAKER_01')]

  assert.equal(attribute(segments, turns)[0].speaker, 'SPEAKER_01')
})

test('an utterance nobody spoke over keeps no speaker at all', () => {
  const segments = [seg(0, 100, 110)]

  const [attributed] = attribute(segments, [turn(0, 10, 'SPEAKER_00')])

  assert.equal(attributed.speaker, undefined)
  assert.ok(!('speaker' in attributed) || attributed.speaker === undefined)
})

test('attribution does not mutate the segments it was given', () => {
  const segments = [seg(0, 0, 5)]

  attribute(segments, [turn(0, 5, 'SPEAKER_00')])

  assert.equal(segments[0].speaker, undefined)
})

// --- formats -----------------------------------------------------------

const diarized: Transcript = {
  engine: 'x',
  model: 'x',
  segments: [
    { index: 0, start: 0, end: 1.5, text: 'erster Satz', speaker: 'SPEAKER_00' },
    { index: 1, start: 1.5, end: 3.25, text: 'zweiter Satz', speaker: 'SPEAKER_01' },
  ],
  text: 'erster Satz zweiter Satz',
  timing: { audio_seconds: 3.25, total_ms: 1, rtf: 0 },
  speakers: ['SPEAKER_00', 'SPEAKER_01'],
}

test('speakers appear in every text format, and only when known', () => {
  assert.equal(renderText(diarized).body, 'SPEAKER_00: erster Satz\nSPEAKER_01: zweiter Satz')
  assert.match(renderSrt(diarized).body, /00:00:00,000 --> 00:00:01,500\n\[SPEAKER_00\] erster Satz/)
  assert.match(renderVtt(diarized).body, /00:00:00\.000 --> 00:00:01\.500\n\[SPEAKER_00\] erster Satz/)

  const plain = { ...diarized, segments: diarized.segments.map(({ speaker, ...rest }) => rest) }
  assert.equal(renderText(plain).body, 'erster Satz\nzweiter Satz')
  assert.ok(!renderSrt(plain).body.includes('['))
})

// --- composition -------------------------------------------------------

function fakeAsr(): AsrEngine {
  return {
    name: 'mock',
    async describe() {
      return {}
    },
    async transcribe(request: TranscribeRequest): Promise<Transcript> {
      const segments = [seg(0, 0, 5, 'hallo'), seg(1, 5, 10, 'welt')]
      return {
        engine: 'mock',
        model: 'mock',
        language: request.language,
        segments,
        text: 'hallo welt',
        timing: { audio_seconds: 10, total_ms: 1, rtf: 0 },
      }
    },
  }
}

function fakeDiarizer(calls: DiarizeRequest[]): DiarizeEngine {
  return {
    name: 'mock-diarizer',
    async describe() {
      return {}
    },
    async diarize(request: DiarizeRequest) {
      calls.push(request)
      return {
        engine: 'mock-diarizer',
        turns: [turn(0, 5, 'SPEAKER_00'), turn(5, 10, 'SPEAKER_01')],
        timing: { audio_seconds: 10, total_ms: 250, rtf: 0.025, turns: 2, speakers: 2 },
      }
    },
  }
}

async function app(calls: DiarizeRequest[]) {
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'mock' })
  await ctx.plugin(diarizePlugin, {})
  await ctx.plugin({
    name: 'engines',
    inject: ['asr', 'diarize'],
    apply(inner: Context) {
      inner.asr.register(fakeAsr())
      inner.diarize.register(fakeDiarizer(calls))
    },
  })
  await ctx.plugin(speakersPlugin, {})
  return ctx
}

test('diarization runs only when the request asks for it', async () => {
  const calls: DiarizeRequest[] = []
  const ctx = await app(calls)

  const plain = await ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe' })
  assert.equal(calls.length, 0)
  assert.equal(plain.segments[0].speaker, undefined)

  const labelled = await ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true })
  assert.equal(calls.length, 1)
  assert.deepEqual(
    labelled.segments.map((segment) => segment.speaker),
    ['SPEAKER_00', 'SPEAKER_01'],
  )
  assert.deepEqual(labelled.speakers, ['SPEAKER_00', 'SPEAKER_01'])
  assert.equal(labelled.timing.diarize_ms, 250)
})

test('a clustering threshold reaches the diarizer', async () => {
  // Threshold, not speaker count: sherpa's num_clusters cuts the dendrogram to
  // N but the frame-level finalisation then drops its outlier clusters, so
  // asking for 3 returned 1. The threshold is the control that survives.
  const calls: DiarizeRequest[] = []
  const ctx = await app(calls)

  await ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true, speakerThreshold: 0.4 })

  assert.equal(calls[0].threshold, 0.4)
  assert.equal(calls[0].path, 'a.wav')
})

test('the utterances go to the diarizer along with the path', async () => {
  // The default engine clusters the utterances rather than segmenting the audio,
  // so the transcript is its input, not just its output. An engine that segments
  // the audio itself ignores this and both stay behind one seam.
  const calls: DiarizeRequest[] = []
  const ctx = await app(calls)

  await ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true })

  assert.deepEqual(calls[0].utterances, [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
  ])
})

test('the post-processor unloads cleanly, leaving transcription alone', async () => {
  const calls: DiarizeRequest[] = []
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'mock' })
  await ctx.plugin(diarizePlugin, {})
  await ctx.plugin({
    name: 'engines',
    inject: ['asr', 'diarize'],
    apply(inner: Context) {
      inner.asr.register(fakeAsr())
      inner.diarize.register(fakeDiarizer(calls))
    },
  })
  const speakers = await ctx.plugin(speakersPlugin, {})

  await speakers.dispose()

  const result = await ctx.asr.transcribe({ path: 'a.wav', task: 'transcribe', diarize: true })
  assert.equal(result.segments[0].speaker, undefined, 'no listener, no labels')
  assert.equal(calls.length, 0, 'and nothing was diarized')
  assert.equal(result.text, 'hallo welt', 'the transcript itself is unaffected')
})
