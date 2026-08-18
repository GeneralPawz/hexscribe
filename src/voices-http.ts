import type { Context } from '@deepseek-ai/cordis'
import { writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {} from './serve/index.ts'
import type {} from './voices.ts'
import type {} from './store.ts'
import type {} from './worker-python.ts'
import { badRequest, notFound } from './serve/errors.ts'

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

/**
 * The run's audio, wherever it is: on disk, or the compressed copy kept for it.
 *
 * The store is handed in rather than read off the context. This plugin does not
 * inject it -- learning is a bonus a server without a database simply does not
 * offer -- and `ctx.store` on a context that never declared it throws.
 */
async function audioFor(
  store: Context['store'],
  run: { id: string; path: string | null; source_path: string | null },
): Promise<{ path: string; cleanup?: () => Promise<void> } | undefined> {
  const readable = async (path: string | null) => {
    if (!path) return false
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }
  if (await readable(run.path)) return { path: run.path as string }
  if (await readable(run.source_path)) return { path: run.source_path as string }

  const stored = store.getAudio(run.id)
  if (!stored) return undefined
  const path = join(tmpdir(), `hexscribe-learn-${randomUUID()}.ogg`)
  await writeFile(path, stored.bytes)
  return { path, cleanup: () => rm(path, { force: true }).then(() => {}) }
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

  /**
   * Learn from a correction.
   *
   * When somebody assigns an utterance to a speaker the clustering did not
   * recognise, that utterance is evidence about how the person sounds — evidence
   * nobody had when the print was made. This embeds exactly those ranges from
   * the run's own audio and folds them into that voice, so the correction makes
   * the next recording easier rather than only fixing this one.
   *
   * Recomputed rather than carried: shipping an embedding per utterance to the
   * browser would be a megabyte of vectors on every transcript, almost all of it
   * never used. Only the lines actually corrected are ever embedded.
   */
  ctx.serve.route('POST', '/v1/voices/learn', async (request) => {
    const { name: voiceName, runId, ranges } = await body(request)
    if (typeof voiceName !== 'string' || !voiceName.trim()) throw badRequest('Learning needs a `name`.')
    if (typeof runId !== 'string') throw badRequest('Learning needs a `runId` to take the audio from.')
    if (!Array.isArray(ranges) || !ranges.length) throw badRequest('Learning needs `ranges`.')

    const store: Context['store'] | undefined = ctx.reflect.get('store')
    const worker: Context['worker'] | undefined = ctx.reflect.get('worker')
    if (!store || !worker) throw badRequest('This server cannot learn from corrections.')

    const run = store.getRun(runId)
    if (!run) throw notFound(`No run ${runId}.`)

    const audio = await audioFor(store, run)
    if (!audio) {
      throw badRequest('The audio for that run is gone, so there is nothing to learn from.')
    }

    try {
      const print = await worker.call<{ embedding: number[]; seconds: number; utterances: number }>(
        'embed_ranges',
        { path: audio.path, ranges },
      )
      if (!print.embedding.length) {
        // Every range was too short to embed. Saying so beats reporting success
        // for a print that did not change.
        return Response.json({ learned: false, reason: 'those utterances are too short to learn from' })
      }
      const voice = await ctx.voices.enroll(voiceName.trim(), print.embedding, print.seconds)
      store.log(
        'info',
        `learned ${print.utterances} corrected utterances (${print.seconds}s) for ${voice.name}`,
        runId,
      )
      const { embedding: _drop, ...rest } = voice
      return Response.json({ learned: true, utterances: print.utterances, seconds: print.seconds, voice: rest })
    } finally {
      await audio.cleanup?.()
    }
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
