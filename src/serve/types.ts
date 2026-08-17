import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'

/**
 * What every route needs: the Cordis context (for `ctx.asr`) and the server's
 * configuration. Passed explicitly to route factories rather than imported, so
 * routes stay unit-testable with a stub context.
 */
export interface ServeDeps {
  ctx: Context
  config: Config
}
