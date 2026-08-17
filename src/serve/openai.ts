/**
 * The OpenAI audio API's own response shapes.
 *
 * Generic renderers (text/srt/vtt) come from `../formats.ts`; what lives here is
 * only what this API defines: the `{ text }` envelope and `verbose_json`.
 *
 * One deliberate deviation: OpenAI's verbose segments carry `avg_logprob`,
 * `compression_ratio` and `temperature`, which this engine does not compute.
 * They are omitted rather than filled with zeros, because a plausible-looking
 * zero is worse than an absent field for anything that reads them.
 */

import type { Transcript } from '../asr.ts'
import { renderSrt, renderText, renderVtt, type Rendered } from '../formats.ts'

export const RESPONSE_FORMATS = ['json', 'text', 'srt', 'verbose_json', 'vtt'] as const
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number]

export function isResponseFormat(value: string): value is ResponseFormat {
  return (RESPONSE_FORMATS as readonly string[]).includes(value)
}

const json = (value: unknown): Rendered => ({
  body: JSON.stringify(value),
  contentType: 'application/json; charset=utf-8',
})

export function verboseBody(transcript: Transcript, task: 'transcribe' | 'translate') {
  return {
    task,
    language: transcript.language ?? null,
    duration: transcript.timing.audio_seconds,
    text: transcript.text,
    // `speaker` is not in OpenAI's schema -- their API has no diarization -- but
    // it is where every tool that does this (WhisperX and friends) puts it, and
    // an unknown extra field is ignored by clients that do not look for it.
    ...(transcript.speakers ? { speakers: transcript.speakers } : {}),
    // The voice prints go out too, so a client can name a speaker it is looking
    // at. They are large-ish (one vector per speaker) and of no use to a client
    // that does not name anyone, so they appear only when diarization ran.
    ...(transcript.voices?.length ? { voices: transcript.voices } : {}),
    // An incomplete transcript must not look like a complete one.
    ...(transcript.damage ? { damage: transcript.damage } : {}),
    segments: transcript.segments.map((segment) => ({
      id: segment.index,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
    })),
  }
}

export function renderOpenAi(
  transcript: Transcript,
  format: ResponseFormat,
  task: 'transcribe' | 'translate',
): Rendered {
  switch (format) {
    case 'text':
      return renderText(transcript)
    case 'srt':
      return renderSrt(transcript)
    case 'vtt':
      return renderVtt(transcript)
    case 'verbose_json':
      return json(verboseBody(transcript, task))
    case 'json':
      return json({ text: transcript.text })
  }
}

/** `text`/`srt`/`vtt` are returned raw; the JSON variants keep the envelope. */
export function toResponse({ body, contentType }: Rendered): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}
