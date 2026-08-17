import type { Context } from '@deepseek-ai/cordis'
import type {} from './serve/index.ts'
import type {} from './jobs.ts'
import type { Job } from './jobs.ts'
import { badRequest, notFound } from './serve/errors.ts'
import { verboseBody } from './serve/openai.ts'

/**
 * Background transcriptions over HTTP.
 *
 * Its own plugin for the same reason as `voices-http`: the jobs service is
 * useful without a server, and the server should not know that background work
 * exists. Remove this file and `POST /v1/audio/transcriptions` still works
 * exactly as it always has — synchronously, which is what an OpenAI client
 * expects and what it will keep getting unless it asks for otherwise.
 *
 * The routes are verbs on a collection rather than REST-with-parameters,
 * because the router matches exact paths by design.
 */
export const name = 'jobs-http'
export const inject = ['serve', 'jobs']

/**
 * What a poller sees. The transcript is left out of listings and of a running
 * job: it does not exist yet, and when it does it is the largest thing here.
 */
function summarise(job: Job) {
  return {
    id: job.id,
    status: job.status,
    name: job.name,
    task: job.task,
    created: job.created,
    finished: job.finished ?? null,
    progress: job.progress,
    ...(job.error ? { error: job.error } : {}),
  }
}

export function apply(ctx: Context) {
  ctx.serve.route('GET', '/v1/jobs', async (request) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return Response.json({ jobs: ctx.jobs.list().map(summarise) })

    const job = ctx.jobs.get(id)
    // A job that has been swept is gone rather than never-existed, but a caller
    // polling it can only act on "not there", so they get the same answer.
    if (!job) throw notFound(`No job ${id}. It may have finished long enough ago to be dropped.`)

    // Always the verbose form, never a rendered subtitle file. It is the only
    // shape carrying segment times, every other rendering is derived from it,
    // and `/ui/format` already exists to do that deriving without the NPU.
    //
    // A running job answers with what it has: the decoder produced those
    // utterances minutes ago, and holding them back until the last one lands is
    // a choice rather than a constraint. `from` lets a poller ask only for what
    // it has not seen, so watching an hour-long run does not re-send the whole
    // transcript once a second.
    const from = Number(new URL(request.url).searchParams.get('from') ?? 0)
    const since = Number.isFinite(from) && from > 0 ? from : 0

    return Response.json({
      ...summarise(job),
      ...(job.transcript
        ? { transcript: verboseBody(job.transcript, job.task) }
        : {
            partial: job.segments.slice(since).map((segment) => ({
              id: segment.index,
              start: segment.start,
              end: segment.end,
              text: segment.text,
              ...(segment.speaker ? { speaker: segment.speaker } : {}),
            })),
            partialFrom: since,
          }),
    })
  })

  ctx.serve.route('POST', '/v1/jobs/forget', async (request) => {
    let body: { id?: unknown }
    try {
      body = (await request.json()) as { id?: unknown }
    } catch {
      throw badRequest('Expected a JSON object body.')
    }
    if (typeof body.id !== 'string') throw badRequest('Forget needs an `id`.')
    return Response.json({ forgotten: ctx.jobs.forget(body.id) })
  })
}
