import type { Context } from '@deepseek-ai/cordis'
import type {} from './serve/index.ts'
import type {} from './voices.ts'
import { badRequest } from './serve/errors.ts'

/**
 * The voice library over HTTP.
 *
 * Its own plugin, so `voices` stays usable without a server (the CLI can name
 * speakers too) and the server stays unaware that voices exist. Both halves are
 * removable independently: drop this file and the library still recognises
 * people, it just cannot be edited from a browser.
 *
 * The router matches exact paths by design, so these are verbs on collections
 * rather than REST-with-parameters. Fitting the API to the router the project
 * has is cheaper than growing the router to fit a convention.
 */
export const name = 'voices-http'
export const inject = ['serve', 'voices']

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw badRequest('Expected a JSON object body.')
  }
}

export function apply(ctx: Context) {
  ctx.serve.route('GET', '/v1/voices', async () => Response.json({ voices: await ctx.voices.list() }))

  ctx.serve.route('POST', '/v1/voices', async (request) => {
    const { name: voiceName, embedding, seconds } = await body(request)
    if (typeof voiceName !== 'string' || !voiceName.trim()) {
      throw badRequest('A voice needs a name.')
    }
    if (!Array.isArray(embedding) || !embedding.length || embedding.some((v) => typeof v !== 'number')) {
      throw badRequest('A voice needs an embedding: the numbers from a transcript\'s `voices` entry.')
    }
    const voice = await ctx.voices.enroll(
      voiceName,
      embedding as number[],
      typeof seconds === 'number' && seconds > 0 ? seconds : 1,
    )
    const { embedding: _drop, ...rest } = voice
    return Response.json(rest)
  })

  ctx.serve.route('POST', '/v1/voices/rename', async (request) => {
    const { from, to } = await body(request)
    if (typeof from !== 'string' || typeof to !== 'string' || !to.trim()) {
      throw badRequest('Rename needs `from` and `to`.')
    }
    const voice = await ctx.voices.rename(from, to)
    if (!voice) throw badRequest(`No stored voice named ${from}.`)
    const { embedding: _drop, ...rest } = voice
    return Response.json(rest)
  })

  ctx.serve.route('POST', '/v1/voices/forget', async (request) => {
    const { name: voiceName } = await body(request)
    if (typeof voiceName !== 'string') throw badRequest('Forget needs a `name`.')
    return Response.json({ forgotten: await ctx.voices.forget(voiceName) })
  })
}
