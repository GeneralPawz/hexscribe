/**
 * Mapping between OpenAI `model` ids and hexscribe ASR engines.
 *
 * Clients send `model: "whisper-1"` because that is what the API says. That id
 * is treated as an alias for the configured default engine, so an unmodified
 * OpenAI client works; naming an engine directly (`model: "qnn"`) also works,
 * which makes engine selection available over HTTP without a bespoke parameter.
 */

import { notFound } from './errors.ts'
import type { ServeDeps } from './types.ts'

/** @returns the engine name to use, or undefined to let `asr` pick its default. */
export function resolveEngine({ ctx, config }: ServeDeps, model: string | null): string | undefined {
  if (!model || model === config.modelAlias) return config.engine
  if (ctx.asr.list().includes(model)) return model
  throw notFound(
    `The model '${model}' does not exist. Available: ${[config.modelAlias, ...ctx.asr.list()].join(', ')}`,
    'model_not_found',
  )
}

export function listModels({ ctx, config }: ServeDeps) {
  const ids = [config.modelAlias, ...ctx.asr.list()]
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', owned_by: 'hexscribe' })),
  }
}
