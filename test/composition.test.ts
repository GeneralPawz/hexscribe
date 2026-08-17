/**
 * These tests are the point of the project as much as the transcription is:
 * they check that the composition claims hold -- registration is reversible,
 * consumers never see an implementation, and independent plugins compose
 * through events without knowing each other.
 *
 * Run: npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as glossaryPlugin from '../src/postproc-glossary.ts'
import type { AsrEngine, Segment, TranscribeRequest, Transcript } from '../src/asr.ts'

function fakeEngine(name: string, text = 'hallo welt'): AsrEngine {
  return {
    name,
    async describe() {
      return { engine: name }
    },
    async transcribe(request: TranscribeRequest, onSegment: (segment: Segment) => void): Promise<Transcript> {
      const segment: Segment = { index: 0, start: 0, end: 1, text }
      onSegment(segment)
      return {
        engine: name,
        model: `${name}-model`,
        language: request.language,
        segments: [segment],
        text,
        timing: { audio_seconds: 1, total_ms: 10, rtf: 0.01 },
      }
    },
  }
}

function enginePlugin(engine: AsrEngine) {
  return {
    name: `engine-${engine.name}`,
    inject: ['asr'],
    apply(ctx: Context) {
      ctx.asr.register(engine)
    },
  }
}

async function app(config: asrPlugin.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(asrPlugin, config)
  return ctx
}

test('an engine plugin contributes a name, and unloading takes it away again', async () => {
  const ctx = await app()
  assert.deepEqual(ctx.asr.list(), [])

  const fiber = await ctx.plugin(enginePlugin(fakeEngine('mock')))
  assert.deepEqual(ctx.asr.list(), ['mock'])

  // The disposer rode on the *calling* plugin's fiber, not the service's.
  await fiber.dispose()
  assert.deepEqual(ctx.asr.list(), [])
})

test('consumers name a capability, not an implementation', async () => {
  const ctx = await app()
  await ctx.plugin(enginePlugin(fakeEngine('alpha', 'from alpha')))
  await ctx.plugin(enginePlugin(fakeEngine('beta', 'from beta')))

  const viaBeta = await ctx.asr.transcribe({ path: 'x.wav', task: 'transcribe', engine: 'beta' })
  assert.equal(viaBeta.text, 'from beta')

  // Two engines, no default: refuse to guess rather than pick silently.
  await assert.rejects(
    () => ctx.asr.transcribe({ path: 'x.wav', task: 'transcribe' }),
    /several asr engines are loaded/,
  )

  // Choosing is configuration, not code.
  const configured = await app({ default: 'alpha' })
  await configured.plugin(enginePlugin(fakeEngine('alpha', 'from alpha')))
  await configured.plugin(enginePlugin(fakeEngine('beta', 'from beta')))
  assert.equal((await configured.asr.transcribe({ path: 'x.wav', task: 'transcribe' })).text, 'from alpha')
})

test('ready() closes the boot race between a front-end and an engine plugin', async () => {
  const ctx = await app()
  // A consumer that acts immediately would otherwise observe an empty registry.
  const pending = ctx.asr.transcribe({ path: 'x.wav', task: 'transcribe' })
  await ctx.plugin(enginePlugin(fakeEngine('late', 'arrived late')))
  assert.equal((await pending).text, 'arrived late')
})

test('ready() still fails loudly when no engine is ever loaded', async () => {
  const ctx = await app()
  await assert.rejects(() => ctx.asr.ready(undefined, 50), /no asr engine registered after 50ms/)
})

test('segments stream as events, so a front-end can render before the end', async () => {
  const ctx = await app({ default: 'mock' })
  await ctx.plugin(enginePlugin(fakeEngine('mock')))

  const seen: string[] = []
  ctx.on('asr/segment', (segment) => void seen.push(segment.text))
  await ctx.asr.transcribe({ path: 'x.wav', task: 'transcribe' })
  assert.deepEqual(seen, ['hallo welt'])
})

test('a post-processor rewrites the transcript without either side knowing the other', async () => {
  const ctx = await app({ default: 'mock' })
  await ctx.plugin(enginePlugin(fakeEngine('mock', 'wir nutzen Kordis auf dem NPU')))
  await ctx.plugin(glossaryPlugin, { terms: { Kordis: 'Cordis' }, wholeWord: true })

  const transcript = await ctx.asr.transcribe({ path: 'x.wav', task: 'transcribe' })
  assert.equal(transcript.text, 'wir nutzen Cordis auf dem NPU')
  assert.equal(transcript.segments[0].text, 'wir nutzen Cordis auf dem NPU')
})

test('two independent post-processors compose in one waterfall', async () => {
  const ctx = await app({ default: 'mock' })
  await ctx.plugin(enginePlugin(fakeEngine('mock', 'Kordis laeuft auf der npu')))
  await ctx.plugin(glossaryPlugin, { terms: { Kordis: 'Cordis' }, wholeWord: true })
  await ctx.plugin(glossaryPlugin, { terms: { npu: 'NPU' }, wholeWord: true })

  const transcript = await ctx.asr.transcribe({ path: 'x.wav', task: 'transcribe' })
  assert.equal(transcript.text, 'Cordis laeuft auf der NPU')
})

test('a waterfall listener that owns the decision short-circuits the engine', async () => {
  const ctx = await app({ default: 'mock' })
  await ctx.plugin(enginePlugin(fakeEngine('mock')))

  // A cache plugin would look like this: answer without calling next().
  const cache = await ctx.plugin({
    name: 'cache',
    apply(inner: Context) {
      inner.on('asr/request', async (request, next) => {
        if (request.path !== 'cached.wav') return next()
        return {
          engine: 'cache',
          model: 'cache',
          segments: [],
          text: 'served from cache',
          timing: { audio_seconds: 0, total_ms: 0, rtf: 0 },
        }
      })
    },
  })

  assert.equal((await ctx.asr.transcribe({ path: 'cached.wav', task: 'transcribe' })).text, 'served from cache')
  assert.equal((await ctx.asr.transcribe({ path: 'other.wav', task: 'transcribe' })).text, 'hallo welt')

  // Unload the cache: the short-circuit is gone with it, no bookkeeping.
  await cache.dispose()
  assert.equal((await ctx.asr.transcribe({ path: 'cached.wav', task: 'transcribe' })).text, 'hallo welt')
})
