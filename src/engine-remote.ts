import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './asr.ts'
import type { Segment, Transcript, TranscribeRequest } from './asr.ts'

export interface Config {
  name: string
  url: string
  model: string
  apiKey?: string
  timeout: number
}

export const Config: Schema<Config> = Schema.object({
  name: Schema.string().default('remote').description('Engine name used by --engine.'),
  url: Schema.string().default('http://127.0.0.1:9000/v1/audio/transcriptions'),
  model: Schema.string().default('whisper-1'),
  apiKey: Schema.string().role('secret'),
  timeout: Schema.number().default(600_000),
})

/**
 * An OpenAI-compatible `/v1/audio/transcriptions` engine.
 *
 * It exists to keep the `asr` seam honest: a second implementation that shares
 * nothing with the NPU engine -- no subprocess, no worker service, no
 * quantization -- and that consumers cannot tell apart. Selecting it is one
 * line of cordis.yml.
 */
export const name = 'engine-remote'
export const inject = ['asr']

export function apply(ctx: Context, config: Config) {
  ctx.asr.register({
    name: config.name,

    async describe() {
      return { engine: config.name, url: config.url, model: config.model, authenticated: !!config.apiKey }
    },

    async transcribe(request: TranscribeRequest, onSegment: (segment: Segment) => void): Promise<Transcript> {
      const started = Date.now()
      const form = new FormData()
      const bytes = await readFile(request.path)
      form.append('file', new Blob([new Uint8Array(bytes)]), basename(request.path))
      form.append('model', config.model)
      if (request.language) form.append('language', request.language)

      const response = await fetch(config.url, {
        method: 'POST',
        body: form,
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        signal: AbortSignal.timeout(config.timeout),
      })
      if (!response.ok) {
        throw new Error(`${config.name}: ${response.status} ${(await response.text()).slice(0, 300)}`)
      }

      const payload = (await response.json()) as { text?: string; duration?: number }
      const text = (payload.text ?? '').trim()
      const total_ms = Date.now() - started
      const audio_seconds = payload.duration ?? 0
      const segment: Segment = { index: 0, start: 0, end: audio_seconds, text }
      onSegment(segment)

      return {
        engine: config.name,
        model: config.model,
        language: request.language,
        segments: [segment],
        text,
        timing: {
          audio_seconds,
          total_ms,
          rtf: audio_seconds ? total_ms / 1000 / audio_seconds : 0,
        },
      }
    },
  })
}
