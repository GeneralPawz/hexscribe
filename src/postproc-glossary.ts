import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './asr.ts'
import type { Transcript } from './asr.ts'

export interface Config {
  terms: Record<string, string>
  wholeWord: boolean
}

export const Config: Schema<Config> = Schema.object({
  terms: Schema.dict(String)
    .default({})
    .description('Replacement map, e.g. { "Kubernetis": "Kubernetes" }. Keys are matched case-insensitively.'),
  wholeWord: Schema.boolean().default(true).description('Only replace standalone words.'),
})

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Corrects domain vocabulary a general model gets wrong (names, jargon).
 *
 * A demonstration of the cooperative half of waterfall discipline: it wraps the
 * downstream result rather than replacing it, so it composes with any other
 * `transcript/finalize` listener without either knowing the other exists, and
 * unloading it removes exactly its own effect.
 */
export const name = 'postproc-glossary'

export function apply(ctx: Context, config: Config) {
  const rules = Object.entries(config.terms).map(([from, to]) => ({
    pattern: new RegExp(config.wholeWord ? `\\b${escape(from)}\\b` : escape(from), 'gi'),
    to,
  }))
  if (!rules.length) return

  const fix = (text: string) => rules.reduce((acc, rule) => acc.replace(rule.pattern, rule.to), text)

  ctx.on('transcript/finalize', async (_transcript, _request, next) => {
    // Delegate first: this plugin annotates, it does not own the decision.
    const result: Transcript = await next()
    return {
      ...result,
      text: fix(result.text),
      segments: result.segments.map((segment) => ({ ...segment, text: fix(segment.text) })),
    }
  })
}
