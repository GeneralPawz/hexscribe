/**
 * POST /v1/audio/transcriptions and /v1/audio/translations.
 *
 * The two endpoints differ only in the task they ask the engine for, so one
 * factory serves both.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../jobs.ts'
import type {} from '../../local-files.ts'
import { badRequest, payloadTooLarge } from '../errors.ts'
import { isResponseFormat, renderOpenAi, RESPONSE_FORMATS, toResponse, type ResponseFormat } from '../openai.ts'
import { resolveEngine } from '../models.ts'
import { saveUpload } from '../upload.ts'
import type { Handler } from '../router.ts'
import type { ServeDeps } from '../types.ts'

/** Formats that carry per-utterance times: asking for them implies timestamps. */
const NEEDS_TIMESTAMPS: ReadonlySet<ResponseFormat> = new Set(['srt', 'vtt', 'verbose_json'])

function readFormat(form: FormData): ResponseFormat {
  const requested = (form.get('response_format') as string | null) ?? 'json'
  if (!isResponseFormat(requested)) {
    throw badRequest(
      `Unsupported response_format '${requested}'. Expected one of: ${RESPONSE_FORMATS.join(', ')}.`,
      'invalid_value',
    )
  }
  return requested
}

function readFile(form: FormData): File {
  const file = form.get('file')
  if (!file) throw badRequest("Missing required parameter: 'file'.", 'missing_required_parameter')
  if (!(file instanceof File)) {
    throw badRequest("Parameter 'file' must be an uploaded file, not a text field.", 'invalid_value')
  }
  return file
}

/**
 * A file already on this machine, instead of an upload.
 *
 * Uploading a 180 MB interview to a server on the same laptop copies it for no
 * reason. Naming it costs nothing and leaves something to play back later.
 * Off unless the `local-files` plugin is loaded, which itself refuses to load
 * when the server is exposed — so this cannot become a way to read files on a
 * machine somebody else can reach.
 */
async function readLocalPath(ctx: Context, path: string) {
  const files: Context['localFiles'] | undefined = ctx.reflect.get('localFiles')
  if (!files) {
    throw badRequest(
      'Transcribing a file by path is not enabled on this server. Upload the file instead, ' +
        'or add local-files.ts to cordis.yml (it requires a loopback bind or an api key).',
      'local_files_unavailable',
    )
  }
  return files.require(path)
}

export function createAudioHandler(deps: ServeDeps, task: 'transcribe' | 'translate'): Handler {
  const { ctx, config } = deps

  return async (request: Request): Promise<Response> => {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      throw badRequest(
        'Could not parse the request body. Send multipart/form-data with a `file` part.',
        'invalid_body',
      )
    }

    // Either an upload or a path on this machine, never both. A path means the
    // bytes never move, which is the whole point of offering it.
    const localPath = form.get('path')
    const local = typeof localPath === 'string' && localPath.trim()
      ? await readLocalPath(ctx, localPath.trim())
      : null

    const file = local ? null : readFile(form)
    if (file && file.size > config.maxUploadBytes) {
      throw payloadTooLarge(`File is ${file.size} bytes; the limit is ${config.maxUploadBytes}.`)
    }

    const format = readFormat(form)
    const engine = resolveEngine(deps, form.get('model') as string | null)
    // `translate` means "into English" for Whisper, so a source language is
    // still meaningful; it is the target that is fixed.
    const language = ((form.get('language') as string | null) || config.language) ?? undefined
    const granularities = form.getAll('timestamp_granularities[]').map(String)

    // An extension beyond the OpenAI surface; absent means off, so a stock
    // client never pays for diarization by accident. There is deliberately no
    // speaker-count parameter -- see README.
    const diarize = ['true', '1', 'yes'].includes(String(form.get('diarize') ?? '').toLowerCase())
    // Absent means "whatever the plugin is configured to do"; present is a
    // decision, either way.
    const mergeField = form.get('merge')
    const merge = mergeField === null ? undefined : ['true', '1', 'yes'].includes(String(mergeField).toLowerCase())

    // Another extension beyond the OpenAI surface, and off unless asked for: a
    // stock client expects a transcript in the response and would be broken by
    // a receipt. Absent means synchronous, exactly as before.
    const background = ['true', '1', 'yes'].includes(String(form.get('background') ?? '').toLowerCase())

    // A local file is read where it is; only an upload needs saving, and only
    // an upload needs deleting afterwards.
    const upload = local ? null : await saveUpload(file!, config.uploadDir)
    const sourcePath = local ? local.path : upload!.path
    const sourceName = local ? local.name : file!.name

    const transcribeRequest = {
      path: sourcePath,
      language,
      task,
      engine,
      timestamps:
        NEEDS_TIMESTAMPS.has(format) || granularities.includes('segment') || config.timestamps || diarize,
      diarize,
      merge,
    }

    if (background) {
      // Looked up rather than injected: this route works without the jobs
      // plugin, and asking for a background run it cannot do is an error worth
      // saying out loud — a client that got a synchronous transcript instead
      // would poll a job id that never existed.
      const jobs: Context['jobs'] | undefined = ctx.reflect.get('jobs')
      if (!jobs) {
        await upload?.cleanup()
        throw badRequest(
          'Background transcription is not enabled on this server; add jobs.ts to cordis.yml, ' +
            'or omit `background` to transcribe synchronously.',
          'background_unavailable',
        )
      }
      // The upload has to outlive this request now, so the job owns deleting it.
      const job = jobs.start(transcribeRequest, {
        name: sourceName,
        source: local ? 'disk' : 'upload',
        ...(local ? { path: local.path } : {}),
        ...(upload ? { cleanup: upload.cleanup } : {}),
      })
      return Response.json({ id: job.id, status: job.status, name: job.name }, { status: 202 })
    }

    try {
      const transcript = await ctx.asr.transcribe(transcribeRequest)
      return toResponse(renderOpenAi(transcript, format, task))
    } finally {
      await upload?.cleanup()
    }
  }
}
