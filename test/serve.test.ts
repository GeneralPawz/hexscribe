/**
 * HTTP front-end tests.
 *
 * They run against a real listening socket with a fake ASR engine, so they
 * cover the parts that break in practice -- multipart parsing, response
 * formats, error envelopes, auth, and the socket's lifecycle -- without needing
 * an NPU. Port 0 lets the OS pick, so the suite never collides with a running
 * server.
 *
 * Run: npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as servePlugin from '../src/serve/index.ts'
import type { AsrEngine, Segment, TranscribeRequest, Transcript } from '../src/asr.ts'

/**
 * Schemastery fills a plugin's remaining config at load time, but the caller's
 * type is `apply`'s parameter — the resolved shape. Tests supply only what they
 * vary, so this is the one place that gap is bridged.
 */
const withDefaults = <T,>(partial: Partial<T>): T => partial as T

interface Recorded {
  last?: TranscribeRequest
}

function fakeEngine(name: string, recorded: Recorded = {}): AsrEngine {
  return {
    name,
    async describe() {
      return { engine: name }
    },
    async transcribe(request: TranscribeRequest, onSegment: (segment: Segment) => void): Promise<Transcript> {
      recorded.last = request
      const segments: Segment[] = [
        { index: 0, start: 0, end: 1.5, text: 'erster Satz' },
        { index: 1, start: 1.5, end: 3.25, text: 'zweiter Satz' },
      ]
      segments.forEach(onSegment)
      return {
        engine: name,
        model: `${name}-model`,
        language: request.language,
        segments,
        text: segments.map((segment) => segment.text).join(' '),
        timing: { audio_seconds: 3.25, total_ms: 10, rtf: 0.003 },
      }
    },
  }
}

function enginePlugin(engine: AsrEngine) {
  return {
    name: `engine-${engine.name}`,
    inject: ['asr'],
    apply: (ctx: Context) => void ctx.asr.register(engine),
  }
}

interface Harness {
  ctx: Context
  url: string
  recorded: Recorded
  post(body: FormData, init?: RequestInit): Promise<Response>
  dispose(): Promise<void>
}

async function harness(config: Partial<servePlugin.ServeConfig> = {}, engines = ['qnn']): Promise<Harness> {
  const recorded: Recorded = {}
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: engines[0] })
  for (const engine of engines) await ctx.plugin(enginePlugin(fakeEngine(engine, recorded)))
  await ctx.plugin(servePlugin, withDefaults<servePlugin.ServeConfig>({ host: '127.0.0.1', port: 0, ...config }))

  const url = await ctx.serve.ready()
  return {
    ctx,
    url,
    recorded,
    post: (body, init) => fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body, ...init }),
    dispose: () => ctx.root.fiber.dispose(),
  }
}

function upload(fields: Record<string, string> = {}): FormData {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([0, 1, 2, 3])], 'clip.ogg', { type: 'audio/ogg' }))
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return form
}

test('transcribes an upload and answers OpenAI json', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const response = await app.post(upload({ model: 'whisper-1', language: 'de' }))

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await response.json(), { text: 'erster Satz zweiter Satz' })
  assert.equal(app.recorded.last?.task, 'transcribe')
  assert.equal(app.recorded.last?.language, 'de')
})

test('the uploaded file reaches the engine as a real path and is cleaned up', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  await app.post(upload())

  const path = app.recorded.last!.path
  assert.ok(path.endsWith('.ogg'), `expected the extension to survive, got ${path}`)
  const { access } = await import('node:fs/promises')
  await assert.rejects(() => access(path), 'the temporary upload should be removed after the request')
})

test('verbose_json exposes segment times', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const body = (await (await app.post(upload({ response_format: 'verbose_json' }))).json()) as any

  assert.equal(body.task, 'transcribe')
  assert.equal(body.duration, 3.25)
  assert.deepEqual(body.segments[1], { id: 1, start: 1.5, end: 3.25, text: 'zweiter Satz' })
  // Fields this engine cannot compute are absent, not zero.
  assert.ok(!('avg_logprob' in body.segments[0]))
})

test('subtitle formats come back as subtitles, not JSON', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const srt = await app.post(upload({ response_format: 'srt' }))
  const vtt = await app.post(upload({ response_format: 'vtt' }))
  const text = await app.post(upload({ response_format: 'text' }))

  assert.match(await srt.text(), /^1\n00:00:00,000 --> 00:00:01,500\nerster Satz/)
  assert.match(vtt.headers.get('content-type') ?? '', /text\/vtt/)
  assert.match(await vtt.text(), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.500/)
  assert.equal(await text.text(), 'erster Satz\nzweiter Satz')
})

test('formats that carry times force timestamped decoding', async (t) => {
  const app = await harness({ timestamps: false })
  t.after(app.dispose)

  await app.post(upload({ response_format: 'json' }))
  assert.equal(app.recorded.last?.timestamps, false)

  await app.post(upload({ response_format: 'srt' }))
  assert.equal(app.recorded.last?.timestamps, true)
})

test('diarization is opt-in over HTTP and off by default', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  await app.post(upload())
  assert.equal(app.recorded.last?.diarize, false, 'a stock OpenAI client must not pay for it')

  await app.post(upload({ diarize: 'true' }))
  assert.equal(app.recorded.last?.diarize, true)
  assert.equal(app.recorded.last?.timestamps, true, 'labels need utterances to attach to')
})

test('/v1/audio/translations asks for the translate task', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  await fetch(`${app.url}/v1/audio/translations`, { method: 'POST', body: upload() })

  assert.equal(app.recorded.last?.task, 'translate')
})

test('a model id selects an engine, and an unknown one is a 404', async (t) => {
  const app = await harness({}, ['qnn', 'remote'])
  t.after(app.dispose)

  const body = (await (await app.post(upload({ model: 'remote' }))).json()) as any
  assert.equal(body.text, 'erster Satz zweiter Satz')
  assert.equal(app.recorded.last?.engine, 'remote')

  const missing = await app.post(upload({ model: 'gpt-4o-transcribe' }))
  assert.equal(missing.status, 404)
  assert.equal(((await missing.json()) as any).error.code, 'model_not_found')
})

test('bad requests answer with the OpenAI error envelope', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const noFile = await app.post(new FormData())
  assert.equal(noFile.status, 400)
  assert.deepEqual(((await noFile.json()) as any).error, {
    message: "Missing required parameter: 'file'.",
    type: 'invalid_request_error',
    code: 'missing_required_parameter',
    param: null,
  })

  const badFormat = await app.post(upload({ response_format: 'yaml' }))
  assert.equal(badFormat.status, 400)
  assert.match(((await badFormat.json()) as any).error.message, /Unsupported response_format/)

  const notMultipart = await app.post('{"file":"x"}' as unknown as FormData, {
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(notMultipart.status, 400)
})

test('unknown paths 404 and wrong methods 405', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const missing = await fetch(`${app.url}/v1/chat/completions`, { method: 'POST', body: upload() })
  assert.equal(missing.status, 404)
  assert.equal(((await missing.json()) as any).error.code, 'unknown_url')

  const wrongMethod = await fetch(`${app.url}/v1/models`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})

test('discovery endpoints describe what is loaded', async (t) => {
  const app = await harness({}, ['qnn', 'remote'])
  t.after(app.dispose)

  const models = (await (await fetch(`${app.url}/v1/models`)).json()) as any
  assert.deepEqual(
    models.data.map((model: any) => model.id),
    ['whisper-1', 'qnn', 'remote'],
  )

  const health = (await (await fetch(`${app.url}/health`)).json()) as any
  assert.equal(health.status, 'ok')
  assert.deepEqual(health.engines, ['qnn', 'remote'])
})

test('an api key is enforced when configured', async (t) => {
  const app = await harness({ apiKey: 'secret-key' })
  t.after(app.dispose)

  const anonymous = await app.post(upload())
  assert.equal(anonymous.status, 401)
  assert.equal(((await anonymous.json()) as any).error.type, 'authentication_error')

  const wrong = await app.post(upload(), { headers: { authorization: 'Bearer nope-wrong-len' } })
  assert.equal(wrong.status, 401)

  const authorized = await app.post(upload(), { headers: { authorization: 'Bearer secret-key' } })
  assert.equal(authorized.status, 200)
})

test('uploads larger than the limit are refused', async (t) => {
  const app = await harness({ maxUploadBytes: 8 })
  t.after(app.dispose)

  const form = new FormData()
  form.append('file', new File([new Uint8Array(64)], 'big.wav'))

  const response = await app.post(form)

  assert.equal(response.status, 413)
})

test('another plugin can add and remove a route', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const extra = await app.ctx.plugin({
    name: 'extra-route',
    inject: ['serve'],
    apply: (ctx: Context) => void ctx.serve.route('GET', '/hello', () => Response.json({ hi: true })),
  })
  assert.equal((await fetch(`${app.url}/hello`)).status, 200)

  await extra.dispose()

  assert.equal((await fetch(`${app.url}/hello`)).status, 404)
})

test('unloading the plugin closes the socket', async () => {
  const app = await harness()
  const { url } = app

  await app.dispose()

  await assert.rejects(() => fetch(`${url}/health`), 'the port should no longer accept connections')
})
