import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from './jobs.ts'
import type {} from './store.ts'
import type {} from './worker-python.ts'
import type { Job } from './jobs.ts'

/**
 * Keeping the audio, small enough to be worth keeping.
 *
 * A transcript with clickable timestamps is only half useful once the recording
 * is gone, and an uploaded one *is* gone — the temporary file is deleted the
 * moment the run finishes. So an upload is re-encoded to 16 kHz mono Opus and
 * the result goes in the database beside the transcript. Measured: 33.8 s
 * becomes 96 kB, so the hour-long interview that arrived as 180 MB is about
 * 10 MB. Keeping the original bytes was never an option at that size.
 *
 * A run read from disk stores nothing: the file is already there, and the run
 * remembers where. Copying it into the database would be the duplication that
 * reading in place exists to avoid.
 *
 * This listens on `job/settled`, which is awaited *before* the upload is
 * deleted — that ordering is the only reason this plugin can work at all.
 * Remove the file and transcripts keep working; they just stop being playable
 * once their upload is cleaned up.
 */
export const name = 'audio-store'
export const inject = ['jobs', 'store', 'worker']

export function apply(ctx: Context) {
  ctx.on('job/settled', async (job: Job) => {
    if (job.status !== 'done') return
    // A disk run already has its audio somewhere permanent.
    if (job.source === 'disk') return
    if (!ctx.store.settings().storeAudio) return

    const destination = join(tmpdir(), `hexscribe-opus-${randomUUID()}.ogg`)
    try {
      const result = await ctx.worker.call<{ bytes: number; seconds: number; mime: string }>(
        'compress_audio',
        { path: job.sourcePath, out: destination },
      )
      const bytes = await readFile(destination)
      ctx.store.saveAudio(job.id, result.mime ?? 'audio/ogg', bytes, bytes.byteLength)
      ctx.store.log(
        'info',
        `stored ${(bytes.byteLength / 1024).toFixed(0)} kB of audio (${result.seconds}s as opus)`,
        job.id,
      )
    } catch (error) {
      // Never fatal. The transcript is finished and already in the caller's
      // hands; failing to keep a copy of the audio is a smaller loss than
      // pretending the run failed.
      ctx.store.log('warn', `could not store audio: ${error}`, job.id)
    } finally {
      await rm(destination, { force: true }).catch(() => {})
    }
  })
}
