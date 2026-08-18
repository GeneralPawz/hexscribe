import type { Context } from '@deepseek-ai/cordis'
import type {} from './serve/index.ts'
import type {} from './store.ts'
import type {} from './local-files.ts'
import { writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {} from './jobs.ts'
import type { Run } from './store.ts'
import { badRequest, notFound } from './serve/errors.ts'
import { verboseBody } from './serve/openai.ts'

/**
 * Where the audio for an interrupted run still is, if anywhere.
 *
 * Three places, in order of preference: the file a disk run read, the upload's
 * temporary copy (still present exactly because the run never settled and so
 * never cleaned up after itself), or the compressed copy in the database, which
 * has to be written back out for the worker to open.
 */
async function findAudio(
  ctx: Context,
  run: Run,
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

  const stored = ctx.store.getAudio(run.id)
  if (!stored) return undefined
  // Opus at 16 kHz is exactly what the model hears anyway, so resuming from the
  // compressed copy costs nothing in accuracy.
  const path = join(tmpdir(), `hexscribe-resume-${randomUUID()}.ogg`)
  await writeFile(path, stored.bytes)
  return { path, cleanup: () => rm(path, { force: true }).then(() => {}) }
}

/**
 * The database over HTTP: history, settings, and the danger zone.
 *
 * Separate from `store.ts` for the usual reason — the database is useful to a
 * CLI that has no server — and separate from `jobs-http.ts` because a job is a
 * thing happening now and a run is a thing that happened. They look alike for
 * about a minute and then diverge: a job is dropped after an hour, a run is
 * kept until somebody deletes it.
 */
export const name = 'store-http'
export const inject = ['serve', 'store']

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
  ctx.serve.route('GET', '/v1/runs', async (request) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return Response.json({ runs: ctx.store.listRuns() })

    const run = ctx.store.getRun(id)
    if (!run) throw notFound(`No run ${id}.`)
    const { transcript, ...rest } = run
    return Response.json({
      ...rest,
      // The verbose shape, so the page renders a stored run with exactly the
      // code that renders a fresh one.
      ...(transcript ? { transcript: verboseBody(transcript, run.task as 'transcribe' | 'translate') } : {}),
      // Sections, comments and tags travel with the run rather than in a second
      // request: the page needs all of them the instant it renders, and a
      // heavily marked-up hour is a few kilobytes against a transcript's sixty.
      annotations: ctx.store.annotations(id),
      logs: ctx.store.recentLogs(50, id),
    })
  })

  /**
   * The stored audio for a run, so a timestamp is still clickable a month
   * later. Whole-file rather than ranged: an Opus copy of an hour is ~10 MB,
   * which a browser is happy to take in one go.
   */
  ctx.serve.route('GET', '/v1/runs/audio', async (request) => {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) throw badRequest('Needs an `id`.')
    const audio = ctx.store.getAudio(id)
    if (!audio) throw notFound(`No stored audio for run ${id}.`)
    return new Response(audio.bytes as never, {
      headers: {
        'content-type': audio.mime,
        'content-length': String(audio.bytes.byteLength),
        'cache-control': 'no-store',
      },
    })
  })

  /**
   * Drop a run's stored audio, optionally pointing it at a file on disk.
   *
   * The two halves of one intent: someone reclaiming space still wants to be
   * able to play the recording, and the copy on their disk is the one to use.
   */
  ctx.serve.route('POST', '/v1/runs/audio/detach', async (request) => {
    const { id, path } = await body(request)
    if (typeof id !== 'string') throw badRequest('Needs an `id`.')
    if (!ctx.store.getRun(id)) throw notFound(`No run ${id}.`)

    const dropped = ctx.store.deleteAudio(id)
    if (typeof path === 'string' && path.trim()) {
      const files: Context['localFiles'] | undefined = ctx.reflect.get('localFiles')
      // Checked rather than trusted: a path that is not there would make the
      // run claim to be playable when it is not.
      if (!files) throw badRequest('Pointing a run at a file needs the local-files plugin.')
      const file = await files.require(path.trim())
      ctx.store.setRunSource(id, 'disk', file.path)
    }
    ctx.store.vacuum()
    return Response.json({ dropped, run: ctx.store.getRun(id), stats: ctx.store.stats() })
  })

  /**
   * Pick an interrupted run back up.
   *
   * Every utterance was written down as it was decoded, so what is missing is
   * the part after the last one — and the engine's seek loop already starts
   * windows at utterance boundaries, so continuing from there is the same move
   * it makes all the way through.
   *
   * What it needs is the audio, and there are three places it might be: the
   * file on disk a disk run read, the upload's temporary copy (still there,
   * precisely because the run never settled and so never cleaned up), or the
   * compressed copy in the database. Anything else and this says so rather than
   * starting from zero and pretending that was a resume.
   */
  ctx.serve.route('POST', '/v1/runs/resume', async (request) => {
    const { id } = await body(request)
    if (typeof id !== 'string') throw badRequest('Resume needs an `id`.')

    const jobs: Context['jobs'] | undefined = ctx.reflect.get('jobs')
    if (!jobs) throw badRequest('Background transcription is not enabled on this server.')

    const run = ctx.store.getRun(id)
    if (!run) throw notFound(`No run ${id}.`)
    if (run.status !== 'interrupted') {
      throw badRequest(`Run ${id} is ${run.status}, not interrupted.`)
    }

    const audio = await findAudio(ctx, run)
    if (!audio) {
      throw badRequest(
        'The audio for this run is gone, so it cannot be continued. ' +
          'Transcribe the file again, or point the run at a copy on disk first.',
      )
    }

    const decoded = ctx.store.runSegments(id)
    const resumeFrom = decoded.length ? decoded[decoded.length - 1].end : 0

    const job = jobs.start(
      {
        path: audio.path,
        language: run.language ?? undefined,
        task: (run.task as 'transcribe' | 'translate') ?? 'transcribe',
        timestamps: true,
        diarize: run.diarize === 1,
        merge: run.merge === 1,
        resumeFrom,
        firstIndex: decoded.length,
      },
      {
        // The same run, continued: a new id would orphan the half already
        // decoded and make the finished half look like a duplicate.
        id: run.id,
        name: run.name,
        source: run.source,
        ...(run.source === 'disk' && run.path ? { path: run.path } : {}),
        ...(audio.cleanup ? { cleanup: audio.cleanup } : {}),
      },
    )
    ctx.store.log('info', `resuming at ${resumeFrom.toFixed(1)}s with ${decoded.length} utterances kept`, run.id)
    return Response.json({ id: job.id, status: job.status, resumeFrom, kept: decoded.length })
  })

  // --- what somebody added by hand ------------------------------------
  //
  // Verbs on collections rather than REST-with-parameters, because the router
  // matches exact paths: fitting the API to the router this project has is
  // cheaper than growing the router to fit a convention.

  ctx.serve.route('GET', '/v1/annotations', async (request) => {
    const id = new URL(request.url).searchParams.get('run')
    if (!id) throw badRequest('Which run? Pass `?run=`.')
    return Response.json(ctx.store.annotations(id))
  })

  ctx.serve.route('POST', '/v1/sections', async (request) => {
    const { runId, start, title } = await body(request)
    if (typeof runId !== 'string') throw badRequest('A section needs a `runId`.')
    if (typeof start !== 'number') throw badRequest('A section needs a `start`.')
    if (typeof title !== 'string' || !title.trim()) throw badRequest('A section needs a title.')
    if (!ctx.store.saveSection(runId, start, title)) throw notFound(`No run ${runId}.`)
    return Response.json({ saved: true, sections: ctx.store.annotations(runId).sections })
  })

  ctx.serve.route('POST', '/v1/sections/delete', async (request) => {
    const { runId, start } = await body(request)
    if (typeof runId !== 'string' || typeof start !== 'number') {
      throw badRequest('Deleting a section needs `runId` and `start`.')
    }
    return Response.json({
      deleted: ctx.store.deleteSection(runId, start),
      sections: ctx.store.annotations(runId).sections,
    })
  })

  ctx.serve.route('POST', '/v1/notes', async (request) => {
    const { runId, start, body: text } = await body(request)
    if (typeof runId !== 'string') throw badRequest('A comment needs a `runId`.')
    if (typeof start !== 'number') throw badRequest('A comment needs a `start`.')
    if (typeof text !== 'string') throw badRequest('A comment needs a `body`; an empty one clears it.')
    // An empty comment clears the row rather than storing whitespace, so the
    // way to undo a comment is to delete its text -- which is what a person
    // does anyway before wondering where the delete button is.
    ctx.store.saveNote(runId, start, text)
    return Response.json({ saved: true, notes: ctx.store.annotations(runId).notes })
  })

  /**
   * Re-anchor annotations after an edit joined two utterances.
   *
   * The page works out what moved -- it is the only side that knows what the
   * transcript looked like a moment ago -- and this applies it in one go, so a
   * merge of twelve rows is one request rather than twelve.
   */
  ctx.serve.route('POST', '/v1/annotations/move', async (request) => {
    const { runId, moves } = await body(request)
    if (typeof runId !== 'string') throw badRequest('Moving annotations needs a `runId`.')
    if (!Array.isArray(moves)) throw badRequest('Moving annotations needs `moves`.')
    let moved = 0
    for (const move of moves as Array<{ from?: unknown; to?: unknown }>) {
      if (typeof move?.from !== 'number' || typeof move?.to !== 'number') continue
      if (ctx.store.moveAnnotations(runId, move.from, move.to)) moved += 1
    }
    return Response.json({ moved, ...ctx.store.annotations(runId) })
  })

  ctx.serve.route('GET', '/v1/tags', async () => Response.json({ tags: ctx.store.listTags() }))

  ctx.serve.route('POST', '/v1/tags', async (request) => {
    const { runId, start, tag, on } = await body(request)
    if (typeof runId !== 'string') throw badRequest('Tagging needs a `runId`.')
    if (typeof start !== 'number') throw badRequest('Tagging needs a `start`.')
    if (typeof tag !== 'string' || !tag.trim()) throw badRequest('Tagging needs a `tag`.')
    const attached = ctx.store.tagUtterance(runId, start, tag, on !== false)
    return Response.json({
      attached,
      tags: ctx.store.annotations(runId).tags,
      library: ctx.store.listTags(),
    })
  })

  ctx.serve.route('POST', '/v1/tags/rename', async (request) => {
    const { from, to } = await body(request)
    if (typeof from !== 'string' || typeof to !== 'string' || !to.trim()) {
      throw badRequest('Renaming a tag needs `from` and `to`.')
    }
    return Response.json({ renamed: ctx.store.renameTag(from, to), tags: ctx.store.listTags() })
  })

  ctx.serve.route('POST', '/v1/tags/delete', async (request) => {
    const { name } = await body(request)
    if (typeof name !== 'string') throw badRequest('Deleting a tag needs a `name`.')
    return Response.json({ deleted: ctx.store.deleteTag(name), tags: ctx.store.listTags() })
  })

  ctx.serve.route('POST', '/v1/runs/rename', async (request) => {
    const { id, name } = await body(request)
    if (typeof id !== 'string') throw badRequest('Rename needs an `id`.')
    if (typeof name !== 'string' || !name.trim()) throw badRequest('A run needs a name.')
    if (!ctx.store.renameRun(id, name)) throw notFound(`No run ${id}.`)
    return Response.json({ renamed: true, name: name.trim() })
  })

  ctx.serve.route('POST', '/v1/runs/delete', async (request) => {
    const { id } = await body(request)
    if (typeof id !== 'string') throw badRequest('Delete needs an `id`.')
    return Response.json({ deleted: ctx.store.deleteRun(id) })
  })

  ctx.serve.route('GET', '/v1/settings', async () =>
    Response.json({ settings: ctx.store.settings(), stats: ctx.store.stats() }),
  )

  ctx.serve.route('POST', '/v1/settings', async (request) => {
    const patch = await body(request)
    return Response.json({ settings: ctx.store.saveSettings(patch), stats: ctx.store.stats() })
  })

  ctx.serve.route('GET', '/v1/logs', async (request) => {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100)
    return Response.json({ logs: ctx.store.recentLogs(Number.isFinite(limit) ? limit : 100) })
  })

  // --- the danger zone -------------------------------------------------
  // Two buttons because they are two different regrets: "I should not be
  // keeping these recordings" and "I should not be keeping any of this".
  ctx.serve.route('POST', '/v1/store/clear-audio', async () => {
    const cleared = ctx.store.clearAudio()
    ctx.store.log('warn', `cleared ${cleared} stored audio clips`)
    return Response.json({ cleared, stats: ctx.store.stats() })
  })

  ctx.serve.route('POST', '/v1/store/reset', async (request) => {
    // A typed confirmation, because this one cannot be undone and a stray
    // POST from a curious client should not be able to do it.
    const { confirm } = await body(request)
    if (confirm !== 'delete everything') {
      throw badRequest('Resetting the database needs `confirm: "delete everything"`.')
    }
    ctx.store.reset()
    return Response.json({ ok: true, stats: ctx.store.stats() })
  })
}
