import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './asr.ts'
import type { Transcript } from './asr.ts'
import { MERGE_DEFAULTS, smartMerge } from './ui/public/js/segments.js'

export interface Config {
  enabled: boolean
  maxGap: number
  maxChars: number
  maxSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Default for requests that do not say; a request always wins.'),
  maxGap: Schema.number()
    .default(MERGE_DEFAULTS.maxGap)
    .description('Seconds of silence that still count as the same sentence continuing. Window boundaries add ~1s that was never a pause.'),
  maxChars: Schema.number().default(MERGE_DEFAULTS.maxChars).description('Stop before an utterance becomes a wall of text.'),
  maxSeconds: Schema.number().default(MERGE_DEFAULTS.maxSeconds).description('Sanity cap on a merged utterance.'),
})

/**
 * Rejoins sentences the decoder split at a window boundary.
 *
 * Whisper cuts every 30 seconds (less, with the sequential seek), and a sentence
 * that straddles a cut arrives as two utterances. The tell is punctuation: the
 * model punctuates what it hears, so an utterance ending without a full stop was
 * interrupted rather than finished.
 *
 * A `transcript/finalize` listener like the glossary and the speaker labels, and
 * for the same reason: the engine that produced the transcript has no idea this
 * exists, and removing the plugin removes the behaviour. The rule itself lives
 * in `ui/public/js/segments.js`, shared with the browser so that clicking
 * *merge* by hand and merging automatically cannot disagree.
 */
export const name = 'postproc-merge'

export function apply(ctx: Context, config: Config) {
  ctx.on('transcript/finalize', async (_transcript, request, next) => {
    const result: Transcript = await next()
    if (!(request.merge ?? config.enabled)) return result

    const segments = smartMerge(result.segments, config)
    if (segments.length === result.segments.length) return result

    return { ...result, segments }
  })
}
