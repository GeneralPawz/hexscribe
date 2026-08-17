import Schema from '@deepseek-ai/schemastery'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  host: string
  port: number
  apiKey?: string
  modelAlias: string
  engine?: string
  language?: string
  timestamps: boolean
  uploadDir: string
  maxUploadBytes: number
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string()
    .default('127.0.0.1')
    .description('Bind address. Loopback by default: this serves unauthenticated local audio.'),
  port: Schema.number().default(9000).description('Port to listen on. 0 picks a free one.'),
  apiKey: Schema.string()
    .role('secret')
    .description('When set, requests must send `Authorization: Bearer <key>`.'),
  modelAlias: Schema.string()
    .default('whisper-1')
    .description('Model id that means "the default engine", so OpenAI clients work unchanged.'),
  engine: Schema.string().description('ASR engine to use when a request names no model.'),
  language: Schema.string().description('Default language code, e.g. de. Omit for auto-detection.'),
  timestamps: Schema.boolean()
    .default(true)
    .description('Ask for per-utterance times. Formats that need them override this per request.'),
  uploadDir: Schema.string()
    .default(join(tmpdir(), 'hexscribe-uploads'))
    .description('Where uploaded audio is written before decoding. Files are removed after each request.'),
  maxUploadBytes: Schema.number()
    .default(200 * 1024 * 1024)
    .description('Reject larger uploads with 413.'),
})
