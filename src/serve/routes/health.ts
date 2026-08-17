/**
 * GET /health -- liveness plus enough detail to answer "is it on the NPU?".
 *
 * Not part of the OpenAI surface; it exists because this is a local server that
 * people will want to check without uploading audio.
 */

import type { Handler } from '../router.ts'
import type { ServeDeps } from '../types.ts'

export function createHealthHandler({ ctx, config }: ServeDeps): Handler {
  return async () => {
    const engines = ctx.asr.list()
    const engine = ctx.asr.get(config.engine)
    return Response.json({
      status: engines.length ? 'ok' : 'no_engine',
      engines,
      model_alias: config.modelAlias,
      engine: engine ? await engine.describe() : null,
    })
  }
}
