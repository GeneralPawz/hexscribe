import type { Context } from '@deepseek-ai/cordis'
import type {} from './jobs.ts'
import type {} from './store.ts'
import type { Job } from './jobs.ts'

/**
 * Writing finished runs down.
 *
 * Its own plugin rather than a call inside `jobs.ts`, because recording history
 * is not part of running a job: the job service works perfectly well with
 * nothing listening, and a composition without a database should not have a
 * jobs service that knows what to do about that. This is the seam where "it
 * happened" becomes "it is remembered", and removing this file removes exactly
 * that and nothing else.
 *
 * Failures are recorded as carefully as successes, and more usefully — a run
 * that failed is precisely the one somebody comes back to look at, and "it
 * didn't work" a day later is not something the browser console can answer.
 */
export const name = 'history'
export const inject = ['jobs', 'store']

export function apply(ctx: Context) {
  ctx.on('job/settled', async (job: Job) => {
    const transcript = job.transcript
    const speakers = transcript?.speakers?.length ?? 0

    try {
      ctx.store.saveRun(
        {
          id: job.id,
          name: job.name,
          source: job.source ?? 'upload',
          path: job.path ?? null,
          status: job.status === 'done' ? 'done' : 'failed',
          created: job.created,
          finished: job.finished ?? Date.now(),
          wall_ms: (job.finished ?? Date.now()) - job.created,
          engine: transcript?.engine ?? null,
          model: transcript?.model ?? null,
          language: transcript?.language ?? null,
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
      ctx.logger?.warn?.(`could not record run ${job.id}: ${error}`)
    }
  })
}
