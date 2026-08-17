import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    diarize: DiarizeService
  }
}

/** One stretch of audio attributed to one speaker. Turns may overlap. */
export interface Turn {
  start: number
  end: number
  /** Stable within a recording only: `SPEAKER_00` is whoever speaks first. */
  speaker: string
}

export interface DiarizeRequest {
  path: string
  /**
   * Cosine-distance threshold below which two voices are the same person.
   * Lower splits more eagerly. Omit for the engine default.
   */
  threshold?: number
  engine?: string
  /**
   * The utterances already found in this audio, when the caller has them.
   *
   * Optional because "who spoke when" is answerable without a transcript, and
   * the pyannote engine answers it that way. An engine that clusters utterances
   * needs them and says so by failing without them; the caller that has them
   * (`speakers`, which runs after the transcript exists) always passes them.
   */
  utterances?: Array<{ start: number; end: number }>
}

export interface DiarizeResult {
  engine: string
  turns: Turn[]
  timing: { audio_seconds: number; total_ms: number; rtf: number; turns: number; speakers: number }
  /**
   * One voice print per speaker, when the engine computes them.
   *
   * Optional because it is not part of answering "who spoke when" — an engine
   * that segments audio and clusters regions has no single vector to offer for
   * a speaker. It is what lets a consumer recognise the same person in another
   * recording, which is a different question again.
   */
  profiles?: Array<{ speaker: string; embedding: number[]; seconds: number; utterances: number }>
}

export interface DiarizeEngine {
  name: string
  describe(): Promise<Record<string, unknown>>
  diarize(request: DiarizeRequest): Promise<DiarizeResult>
}

export interface Config {
  default?: string
}

/**
 * "Who spoke when", as a seam of its own.
 *
 * Separate from `asr` because it answers a different question about the same
 * audio, runs on different hardware (CPU, not the NPU), and costs several times
 * as much — a consumer that wants a transcript should not pay for speakers
 * unless it asked. The registry mirrors `asr` exactly, including `ready()`:
 * an engine plugin contributes after this service exists, so a caller acting at
 * boot must be able to wait.
 */
export class DiarizeService extends Service {
  private engines = new Map<string, DiarizeEngine>()
  private waiters = new Set<{ name?: string; resolve: () => void }>()

  constructor(
    ctx: Context,
    public config: Config = {},
  ) {
    super(ctx, 'diarize')
  }

  register(engine: DiarizeEngine) {
    return this.ctx.effect(() => {
      if (this.engines.has(engine.name)) {
        throw new Error(`diarization engine already registered: ${engine.name}`)
      }
      this.engines.set(engine.name, engine)
      for (const waiter of [...this.waiters]) {
        if (!waiter.name || waiter.name === engine.name) {
          this.waiters.delete(waiter)
          waiter.resolve()
        }
      }
      return () => void this.engines.delete(engine.name)
    }, `diarize-engine:${engine.name}`)
  }

  list(): string[] {
    return [...this.engines.keys()]
  }

  get(name?: string): DiarizeEngine | undefined {
    const resolved = name ?? this.config.default
    if (resolved) return this.engines.get(resolved)
    return this.engines.size === 1 ? this.engines.values().next().value : undefined
  }

  async ready(name?: string, timeout = 10_000): Promise<void> {
    if (name ? this.engines.has(name) : this.engines.size > 0) return
    await new Promise<void>((resolveReady, reject) => {
      const waiter = {
        name,
        resolve: () => {
          clearTimeout(timer)
          resolveReady()
        },
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(
          new Error(
            `no diarization engine${name ? ` named ${name}` : ''} registered after ${timeout}ms ` +
              `(registered: ${this.list().join(', ') || 'none'})`,
          ),
        )
      }, timeout)
      this.waiters.add(waiter)
    })
  }

  async run(request: DiarizeRequest): Promise<DiarizeResult> {
    await this.ready(request.engine ?? this.config.default)
    const engine = this.get(request.engine)
    if (!engine) {
      throw new Error(
        `no diarization engine selected (registered: ${this.list().join(', ') || 'none'})`,
      )
    }
    return engine.diarize(request)
  }
}

export const name = 'diarize'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(DiarizeService, config)
}
