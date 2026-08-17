import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    asr: AsrService
  }

  interface Events {
    /** One decoded window landed. Observers only; see `asr/request` to intervene. @mode emit */
    'asr/segment'(segment: Segment, request: TranscribeRequest): void
    /**
     * How long the audio is, once an engine knows and before it has finished.
     *
     * The denominator of any progress report: segments arrive carrying an `end`
     * time, and turning that into "34 minutes of 79" needs the 79. Optional by
     * nature — an engine that posts a file to someone else's API never learns
     * this, and an observer must cope with never hearing it.
     * @mode emit
     */
    'asr/audio'(seconds: number, request: TranscribeRequest): void
    /** Around the whole transcription. Listeners may rewrite the request, replace the
     *  result, or short-circuit (a cache). Call `next()` unless you own the decision.
     *  @mode waterfall */
    'asr/request'(request: TranscribeRequest, next: () => Promise<Transcript>): Promise<Transcript>
    /** Post-processing chain over a finished transcript: glossaries, punctuation,
     *  speaker labels, redaction. Cooperative listeners mutate and delegate.
     *
     *  The request travels with the transcript because post-processing is not
     *  always a pure text operation: attributing speakers means looking at the
     *  audio again, and only the request knows where that audio is.
     *  @mode waterfall */
    'transcript/finalize'(
      transcript: Transcript,
      request: TranscribeRequest,
      next: () => Promise<Transcript>,
    ): Promise<Transcript>
  }
}

export interface Segment {
  index: number
  start: number
  end: number
  text: string
  /** Set only when diarization ran, e.g. `SPEAKER_00`. */
  speaker?: string
}

/**
 * What every engine can report, plus what only a local one can.
 *
 * The optional half exists because a second engine (a remote HTTP one) could
 * not answer it: an engine that does not run the graph itself has no encoder
 * time and no token count. Making those optional keeps the seam honest instead
 * of forcing every engine to invent numbers.
 */
export interface Timing {
  audio_seconds: number
  total_ms: number
  rtf: number
  feature_ms?: number
  encode_ms?: number
  decode_ms?: number
  tokens?: number
  ms_per_token?: number
  chunks?: number
  /** Time spent attributing speakers, when diarization ran. */
  diarize_ms?: number
}

export interface TranscribeRequest {
  /** Absolute path to an audio file in any container ffmpeg can open. */
  path: string
  /** ISO code such as `de`; omit to let the model detect it. */
  language?: string
  task: 'transcribe' | 'translate'
  /** Engine name; omit to use the service default. */
  engine?: string
  /**
   * Ask for per-utterance timing. Engines that cannot produce it return
   * whole-file segments; nothing here promises the engine obeys.
   */
  timestamps?: boolean
  /**
   * Seconds to start at, for a run being resumed rather than begun.
   *
   * The engine's seek loop already works by "start the next window where the
   * last utterance ended"; this is the same move made once, at the beginning.
   * Only an engine that decodes locally can honour it -- one that posts a file
   * to somebody else's API cannot, which is why it is optional.
   */
  resumeFrom?: number
  /** What to number the first utterance, so a resumed run continues the count. */
  firstIndex?: number
  /** Attribute utterances to speakers. Opt-in: it costs several times the transcription. */
  diarize?: boolean
  /**
   * Rejoin sentences the decoder split at a window boundary. Omit to take the
   * `postproc-merge` plugin's default; false always wins.
   */
  merge?: boolean
  /**
   * Diarization clustering threshold; lower finds more speakers. Omit for the
   * default. There is no exact speaker-count option: see README, sherpa's
   * num_clusters does not survive the pipeline.
   */
  speakerThreshold?: number
}

export interface Transcript {
  engine: string
  model: string
  language?: string
  segments: Segment[]
  text: string
  timing: Timing
  /** Distinct speakers found, when diarization ran. */
  speakers?: string[]
  /**
   * What each speaker sounded like, when the diarizer offered voice prints.
   *
   * Carried so a consumer can name a speaker and have that name recognised in
   * the next recording — the transcript is where the print and the label are
   * both known, and it is the only place they are.
   */
  voices?: SpeakerVoice[]
  /**
   * Present only when part of the audio could not be decoded.
   *
   * Recordings are routinely blemished — a truncated final frame is normal — and
   * skipping a packet is the right call over discarding the hour around it. But
   * the result is then a transcript of *most* of a file, and that has to be
   * visible: nothing downstream can tell an incomplete transcript from a
   * complete one by looking at it.
   */
  damage?: { skipped_packets: number; total_packets: number }
}

export interface SpeakerVoice {
  /** The label in `segments`, so a consumer can join the two. */
  speaker: string
  embedding: number[]
  seconds: number
  utterances: number
  /** Set when a stored voice was recognised, with the distance that decided it. */
  matched?: { name: string; distance: number }
}

/** What a plugin must provide to be an ASR backend. */
export interface AsrEngine {
  name: string
  /** Human-readable one-liner for `--doctor`. */
  describe(): Promise<Record<string, unknown>>
  transcribe(request: TranscribeRequest, onSegment: (segment: Segment) => void): Promise<Transcript>
}

interface Waiter {
  name?: string
  resolve: () => void
}

export interface Config {
  /** Engine used when a request names none. Required once more than one is loaded. */
  default?: string
}

export const Config: Schema<Config> = Schema.object({
  default: Schema.string().description('Engine name to use when a request does not name one.'),
})

export class AsrService extends Service {
  private engines = new Map<string, AsrEngine>()
  private waiters = new Set<Waiter>()

  constructor(
    ctx: Context,
    public config: Config = {},
  ) {
    super(ctx, 'asr')
  }

  /**
   * Register an engine. The disposer is attached to the *calling* plugin's fiber,
   * so unloading an engine plugin removes its engine and nothing else.
   */
  register(engine: AsrEngine) {
    return this.ctx.effect(() => {
      if (this.engines.has(engine.name)) {
        throw new Error(`asr engine already registered: ${engine.name}`)
      }
      this.engines.set(engine.name, engine)
      for (const waiter of [...this.waiters]) {
        if (!waiter.name || waiter.name === engine.name) {
          this.waiters.delete(waiter)
          waiter.resolve()
        }
      }
      return () => {
        this.engines.delete(engine.name)
      }
    }, `asr-engine:${engine.name}`)
  }

  /**
   * Resolve once a matching engine exists.
   *
   * `inject` orders *services*, and `asr` is available the moment this plugin
   * loads -- before any engine plugin has contributed to the registry. A
   * consumer that acts immediately at boot (a CLI does; a server does not) can
   * therefore observe an empty registry, so readiness is a first-class call
   * rather than something every front-end reinvents. It fails loudly after the
   * timeout instead of hanging on a misconfiguration.
   */
  async ready(name?: string, timeout = 10_000): Promise<void> {
    if (name ? this.engines.has(name) : this.engines.size > 0) return
    await new Promise<void>((resolveReady, reject) => {
      const waiter: Waiter = {
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
            `no asr engine${name ? ` named ${name}` : ''} registered after ${timeout}ms ` +
              `(registered: ${this.list().join(', ') || 'none'}). Is an engine plugin listed in cordis.yml?`,
          ),
        )
      }, timeout)
      this.waiters.add(waiter)
    })
  }

  list(): string[] {
    return [...this.engines.keys()]
  }

  /** The name a request without an explicit engine resolves to, if it is decidable. */
  resolveName(requested?: string): string | undefined {
    if (requested) return requested
    if (this.config.default) return this.config.default
    // Nothing configured: the sole registered engine, or nothing to guess between.
    return this.engines.size === 1 ? this.engines.keys().next().value : undefined
  }

  get(name?: string): AsrEngine | undefined {
    const resolved = this.resolveName(name)
    return resolved ? this.engines.get(resolved) : undefined
  }

  async transcribe(request: TranscribeRequest): Promise<Transcript> {
    await this.ready(request.engine ?? this.config.default)
    return this.ctx.waterfall('asr/request', request, async () => {
      const engine = this.get(request.engine)
      if (!engine) {
        const available = this.list()
        const wanted = request.engine ?? this.config.default
        throw new Error(
          wanted
            ? `no such asr engine: ${wanted} (available: ${available.join(', ') || 'none'})`
            : `several asr engines are loaded (${available.join(', ')}); pass --engine or set a default in cordis.yml`,
        )
      }
      const transcript = await engine.transcribe(request, (segment) => {
        this.ctx.emit('asr/segment', segment, request)
      })
      return this.ctx.waterfall('transcript/finalize', transcript, request, async () => transcript)
    })
  }
}

export const name = 'asr'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(AsrService, config)
}
