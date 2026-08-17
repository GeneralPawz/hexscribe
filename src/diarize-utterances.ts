import type { Context } from '@deepseek-ai/cordis'
import type {} from './diarize.ts'
import type {} from './worker-python.ts'
import type { DiarizeRequest, DiarizeResult } from './diarize.ts'

/**
 * Diarization that clusters the utterances instead of segmenting the audio.
 *
 * The other engine asks the audio "who spoke when" and then we map its answer
 * onto utterances. This one starts from the utterances, which is the question we
 * actually have: by the time diarization runs, Whisper has already cut the audio
 * on the speech it heard, and those cuts land on speaker changes more reliably
 * than a segmentation model's do. Each utterance becomes one speaker vector, and
 * the vectors are clustered.
 *
 * Measured on `test/fixtures`: the pyannote path reports one speaker for a
 * three-speaker recording at every threshold and *two* for a one-speaker
 * recording at its default; this path gets both right across a wide band of
 * thresholds. It is also much cheaper -- no segmentation pass, just one short
 * embedding per utterance.
 *
 * Two engines, one seam, and `cordis.yml` picks. Removing this file leaves the
 * pyannote engine as the only one registered and everything downstream unchanged
 * -- the attribution step cannot tell which engine produced the turns.
 */
export const name = 'diarize-utterances'
export const inject = ['diarize', 'worker']

export function apply(ctx: Context) {
  ctx.diarize.register({
    name: 'utterances',

    async describe() {
      const info = await ctx.worker.call<Record<string, unknown>>('info')
      return { engine: 'utterances', available: info.utterance_diarization_available ?? false }
    },

    async diarize(request: DiarizeRequest): Promise<DiarizeResult> {
      if (!request.utterances?.length) {
        // Not a silent empty answer: a caller that forgot the utterances would
        // otherwise see "no speakers found" and believe it.
        throw new Error(
          'the utterances engine needs the utterances to cluster; ' +
            'call it after transcription, or select the sherpa engine',
        )
      }

      const result = await ctx.worker.call<Omit<DiarizeResult, 'engine'>>('diarize_utterances', {
        // The worker returns a voice print per speaker alongside the turns; it
        // costs nothing extra, being the centroid of vectors already computed.
        path: request.path,
        threshold: request.threshold,
        utterances: request.utterances.map(({ start, end }) => ({ start, end })),
      })
      return { engine: 'utterances', ...result }
    },
  })
}
