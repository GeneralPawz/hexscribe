/**
 * POST /ui/format?to=srt -- re-render a transcript the browser already has.
 *
 * The page holds a `verbose_json` result and lets you download it as SRT, VTT or
 * text. Rendering those in browser JS would be a second implementation of what
 * `formats.ts` already does, and re-requesting the API in another format would
 * re-run a transcription that has already been paid for. So the page posts the
 * transcript back and gets it rendered by the same code the CLI uses.
 *
 * Stateless, and outside `/v1` because it is not part of the OpenAI surface.
 */

import type { Segment, Transcript } from '../asr.ts'
import { isFormatName, render, FORMAT_NAMES } from '../formats.ts'
import { badRequest } from '../serve/errors.ts'
import type { Handler } from '../serve/router.ts'

interface VerbosePayload {
  text?: string
  language?: string | null
  duration?: number
  speakers?: string[]
  segments?: Array<{ id?: number; start?: number; end?: number; text?: string; speaker?: string }>
}

/** Map the OpenAI `verbose_json` shape back onto our own transcript. */
function toTranscript(payload: VerbosePayload): Transcript {
  if (!Array.isArray(payload.segments)) {
    throw badRequest('Body must be a verbose_json transcript with a `segments` array.', 'invalid_body')
  }
  const segments: Segment[] = payload.segments.map((segment, index) => ({
    index: segment.id ?? index,
    start: Number(segment.start ?? 0),
    end: Number(segment.end ?? 0),
    text: String(segment.text ?? ''),
    // Carried through deliberately: an exported subtitle must say who spoke,
    // and dropping the field here silently produced unlabelled downloads.
    ...(segment.speaker ? { speaker: String(segment.speaker) } : {}),
  }))
  return {
    engine: 'ui',
    model: '',
    language: payload.language ?? undefined,
    segments,
    text: payload.text ?? segments.map((segment) => segment.text).join(' '),
    timing: { audio_seconds: payload.duration ?? 0, total_ms: 0, rtf: 0 },
    ...(payload.speakers ? { speakers: payload.speakers } : {}),
  }
}

export function createFormatHandler(): Handler {
  return async (request: Request): Promise<Response> => {
    const to = new URL(request.url).searchParams.get('to') ?? 'text'
    if (!isFormatName(to)) {
      throw badRequest(`Unknown format '${to}'. Expected one of: ${FORMAT_NAMES.join(', ')}.`, 'invalid_value')
    }

    let payload: VerbosePayload
    try {
      payload = (await request.json()) as VerbosePayload
    } catch {
      throw badRequest('Body must be JSON.', 'invalid_body')
    }

    const { body, contentType } = render(toTranscript(payload), to)
    return new Response(body, { headers: { 'content-type': contentType } })
  }
}
