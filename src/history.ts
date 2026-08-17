import type { Context } from '@deepseek-ai/cordis'
import type {} from './jobs.ts'
import type {} from './store.ts'
import type { Job } from './jobs.ts'
import type { Segment, Transcript } from './asr.ts'

/**
 * Writing runs down as they happen.
 *
 * Its own plugin rather than a call inside `jobs.ts`, because recording history
 * is not part of running a job: the job service works perfectly well with
 * nothing listening, and a composition without a database should not have a
 * jobs service that knows what to do about that.
 *
 * It writes three times, and the middle one is the point. A row appears when the
 * job *starts*, every utterance is appended the moment it is decoded, and the
 * finished transcript replaces the lot at the end. Writing only at the end was
 * simpler and meant that four minutes into an hour-long run there was nothing on
 * disk at all — so a crash, a restart or a closed laptop cost everything. Now it
 * costs the last utterance.
 *
 * Failures are recorded as carefully as successes, and more usefully: a run that
 * failed is precisely the one somebody comes back to look at, and "it didn't
 * work" a day later is not something the browser console can answer.
 */
export const name = 'history'
export const inject = ['jobs', 'store']

/**
 * Say that recording failed, somewhere a person will actually see.
 *
 * This composition attaches no console exporter, so `ctx.logger` alone is a
 * decision to fail silently — which is how a schema mismatch once stopped every
 * run being recorded without a single visible sign. stderr is where the server
 * already writes the things that matter.
 */
function report(ctx: Context, message: string, error: unknown) {
  const detail = `${message}: ${error instanceof Error ? error.message : error}`
  ctx.logger?.warn?.(detail)
  process.stderr.write(`hexscribe: ${detail}
`)
}

export function apply(ctx: Context) {
  ctx.on('job/started', (job: Job) => {
    try {
      ctx.store.saveRun({
        id: job.id,
        name: job.name,
        source: job.source,
        path: job.path ?? null,
        // Kept so an interrupted upload can be resumed: its temporary file is
        // deleted when a job settles, and an interrupted one never settled.
        source_path: job.sourcePath,
        status: 'running',
        created: job.created,
        finished: 0,
        wall_ms: 0,
        engine: null,
        model: null,
        // From the request, not from a transcript that does not exist yet: this
        // is the field a resume reads back, and losing it means auto-detection.
        language: job.language ?? null,
        task: job.task,
        diarize: job.diarize ? 1 : 0,
        merge: job.merge ? 1 : 0,
        audio_seconds: 0,
        segments: 0,
        speakers: 0,
        rtf: 0,
        error: null,
      })
    } catch (error) {
      report(ctx, `could not open run ${job.id}`, error)
    }
  })

  ctx.on('job/progress', (job: Job, segment?: Segment) => {
    if (!segment) return
    try {
      ctx.store.appendSegment(job.id, segment)
    } catch (error) {
      // One lost utterance is not worth ending a run over, and the transcript
      // written at the end will contain it anyway.
      ctx.logger?.debug?.(`could not append utterance ${segment.index}: ${error}`)
    }
  })

  ctx.on('job/settled', async (job: Job) => {
    const finished = job.finished ?? Date.now()
    try {
      // A resumed run's engine transcript holds only the part it decoded. What
      // was stored before the interruption is still in `run_segments`, so the
      // two are joined here — this is the one place that knows about both.
      const transcript = job.transcript ? join(ctx, job, job.transcript) : undefined
      const speakers = transcript?.speakers?.length ?? 0

      ctx.store.saveRun(
        {
          id: job.id,
          name: job.name,
          source: job.source,
          path: job.path ?? null,
          source_path: job.sourcePath,
          status: job.status === 'done' ? 'done' : 'failed',
          created: job.created,
          finished,
          wall_ms: finished - job.created,
          engine: transcript?.engine ?? null,
          model: transcript?.model ?? null,
          language: transcript?.language ?? job.language ?? null,
          task: job.task,
          diarize: job.diarize ? 1 : 0,
          merge: job.merge ? 1 : 0,
          audio_seconds: transcript?.timing.audio_seconds ?? job.progress.duration ?? 0,
          segments: transcript?.segments.length ?? 0,
          speakers,
          rtf: transcript?.timing.rtf ?? 0,
          error: job.error ?? null,
        },
        transcript,
      )

      if (transcript) {
        // The streamed copies have served their purpose; the transcript is now
        // the record, and it is the one post-processing has been applied to.
        ctx.store.clearRunSegments(job.id)
      }

      if (job.status === 'failed') {
        ctx.store.log('error', job.error ?? 'the transcription failed', job.id)
      } else {
        const timing = transcript?.timing
        ctx.store.log(
          'info',
          `${job.name}: ${transcript?.segments.length ?? 0} utterances, ` +
            `${(timing?.audio_seconds ?? 0).toFixed(1)}s of audio, rtf ${timing?.rtf ?? 0}`,
          job.id,
        )
      }
      // Damage is worth its own line: it is the difference between a transcript
      // and most of one, and a month later nothing else records it.
      if (transcript?.damage?.skipped_packets) {
        ctx.store.log(
          'warn',
          `skipped ${transcript.damage.skipped_packets} of ${transcript.damage.total_packets} audio packets`,
          job.id,
        )
      }
    } catch (error) {
      // A database that will not write must not take the transcript down with
      // it: the job has already succeeded and the caller is holding the result.
      report(ctx, `could not record run ${job.id}`, error)
    }
  })
}

/**
 * Put a resumed run back together.
 *
 * The engine only ever saw the part it was asked to decode, so its transcript
 * starts at the resume point. Everything before that is in `run_segments`,
 * where it was written as it happened.
 *
 * The seam between them is not re-processed: the merge pass ran over the new
 * half only, so a sentence split exactly at the interruption stays split. That
 * is one join to fix by hand against an hour saved, and pretending otherwise
 * would mean re-running post-processing over segments whose audio is gone.
 */
function join(ctx: Context, job: Job, transcript: Transcript): Transcript {
  const stored = ctx.store.runSegments(job.id)
  if (!stored.length) return transcript

  const first = transcript.segments[0]?.start ?? Infinity
  const before = stored.filter((segment) => segment.end <= first + 0.001)
  if (!before.length) return transcript

  const segments = [...before, ...transcript.segments].map((segment, index) => ({ ...segment, index }))
  return {
    ...transcript,
    segments,
    text: segments.map((segment) => segment.text).join(' '),
  }
}
