import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './asr.ts'
import type { Segment, TranscribeRequest, Transcript } from './asr.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobService
  }
}

export type JobStatus = 'running' | 'done' | 'failed'

export interface JobProgress {
  /** Seconds of audio transcribed so far — the last utterance's end time. */
  seconds: number
  /** Utterances produced so far. */
  segments: number
  /** Total seconds, once an engine has said. Absent until then, and forever
   *  for an engine that cannot answer. */
  duration?: number
  /** 0..1, only when a duration is known. Never fabricated from an estimate. */
  fraction?: number
}

export interface Job {
  id: string
  status: JobStatus
  /** The name the file arrived under, so a notification can say which one. */
  name: string
  task: 'transcribe' | 'translate'
  created: number
  finished?: number
  progress: JobProgress
  transcript?: Transcript
  error?: string
}

export interface StartOptions {
  name: string
  /** Called once the job settles, however it settles — the upload is deleted here. */
  cleanup?: () => Promise<void> | void
}

export interface Config {
  retainMinutes: number
  maxJobs: number
}

export const Config: Schema<Config> = Schema.object({
  retainMinutes: Schema.number()
    .default(60)
    .description('How long a finished job stays fetchable before it is dropped.'),
  maxJobs: Schema.number()
    .default(50)
    .description('Oldest finished jobs are dropped past this, so a long session cannot grow without bound.'),
})

/**
 * Transcriptions that outlive the request that asked for them.
 *
 * The synchronous endpoint holds one HTTP connection open for the whole run.
 * That is fine for a voice memo and wrong for an interview: an hour of audio is
 * four and a half minutes of NPU, during which the caller has a connection it
 * cannot use, no idea how far along it is, and no result at all if the tab
 * closes. This keeps the work on the server and hands back a receipt.
 *
 * Progress is real, not estimated. The engine emits an utterance the moment it
 * decodes one, carrying the time it ended, and the audio's duration arrives
 * before any of it — so "34 minutes of 79" is measured. When an engine cannot
 * report a duration the fraction is simply absent rather than invented; the
 * seconds transcribed are still true.
 *
 * Jobs live in memory. A restart loses them, which is the honest scope for a
 * local tool: persisting them would mean persisting the audio too, and the
 * uploads are deliberately temporary.
 */
export class JobService extends Service {
  private jobs = new Map<string, Job>()
  /** Live runs, keyed by the request object the engine will echo back. */
  private watching = new Map<TranscribeRequest, string>()
  private disposed = false

  constructor(
    ctx: Context,
    public config: Config,
  ) {
    super(ctx, 'jobs')

    // Progress arrives as events about a request, not about a job: the ASR seam
    // has never heard of jobs and should not. The request object is the join.
    ctx.on('asr/segment', (segment: Segment, request: TranscribeRequest) => {
      const job = this.jobs.get(this.watching.get(request) ?? '')
      if (!job || job.status !== 'running') return
      job.progress.segments += 1
      job.progress.seconds = Math.max(job.progress.seconds, segment.end)
      this.recompute(job)
    })

    ctx.on('asr/audio', (seconds: number, request: TranscribeRequest) => {
      const job = this.jobs.get(this.watching.get(request) ?? '')
      if (!job) return
      job.progress.duration = seconds
      this.recompute(job)
    })

    ctx.effect(() => () => {
      // Nothing to cancel: the worker owns the run and dies with its own plugin.
      // What must stop is this service reporting on it afterwards.
      this.disposed = true
      this.watching.clear()
    }, 'jobs-state')
  }

  private recompute(job: Job) {
    const { duration, seconds } = job.progress
    job.progress.fraction = duration && duration > 0 ? Math.min(1, seconds / duration) : undefined
  }

  /**
   * Begin a transcription and return immediately.
   *
   * The promise is deliberately not returned: the caller is answering an HTTP
   * request that is about to end, and an unawaited rejection must not become an
   * unhandled one — so every outcome is recorded on the job instead.
   */
  start(request: TranscribeRequest, options: StartOptions): Job {
    // Sweep whenever the collection grows, not only when one finishes: a
    // session that starts jobs and never finishes another would otherwise keep
    // every result it has ever produced.
    this.sweep()

    const job: Job = {
      id: randomUUID(),
      status: 'running',
      name: options.name,
      task: request.task,
      created: Date.now(),
      progress: { seconds: 0, segments: 0 },
    }
    this.jobs.set(job.id, job)
    this.watching.set(request, job.id)

    void this.run(job, request, options)
    return job
  }

  private async run(job: Job, request: TranscribeRequest, options: StartOptions) {
    try {
      const transcript = await this.ctx.asr.transcribe(request)
      if (this.disposed) return
      job.transcript = transcript
      job.status = 'done'
      // The engine's own count is the truth at the end; the streamed one can
      // lag it when post-processing merged utterances after the fact.
      job.progress.segments = transcript.segments.length
      job.progress.duration ??= transcript.timing.audio_seconds
      job.progress.seconds = job.progress.duration ?? job.progress.seconds
      this.recompute(job)
    } catch (error) {
      if (this.disposed) return
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      job.finished = Date.now()
      this.watching.delete(request)
      await Promise.resolve(options.cleanup?.()).catch(() => {})
      this.sweep()
    }
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** Newest first, because that is the one a caller is looking for. */
  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.created - a.created)
  }

  forget(id: string): boolean {
    return this.jobs.delete(id)
  }

  /** Drop finished jobs that are old or surplus. Running ones are never dropped. */
  private sweep() {
    const cutoff = Date.now() - this.config.retainMinutes * 60_000
    const finished = this.list().filter((job) => job.status !== 'running')

    for (const job of finished) {
      if ((job.finished ?? job.created) < cutoff) this.jobs.delete(job.id)
    }
    const remaining = this.list().filter((job) => job.status !== 'running')
    for (const job of remaining.slice(this.config.maxJobs)) this.jobs.delete(job.id)
  }
}

export const name = 'jobs'
export const inject = ['asr']

export function apply(ctx: Context, config: Config) {
  ctx.plugin(JobService, config)
}
