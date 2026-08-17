/**
 * Transcript renderers.
 *
 * Pure functions over a `Transcript` -- no Cordis, no I/O, no framework import --
 * so every front-end shares one implementation of what an SRT looks like. The
 * CLI writes the result to a file; the HTTP server puts it in a response body.
 *
 * API-shaped envelopes (OpenAI's `{ text }` / `verbose_json`) deliberately do
 * *not* live here: they belong to the API that defines them, in `serve/openai.ts`.
 */

import type { Transcript } from './asr.ts'

export const FORMAT_NAMES = ['text', 'srt', 'vtt', 'json'] as const
export type FormatName = (typeof FORMAT_NAMES)[number]

export interface Rendered {
  body: string
  contentType: string
}

function clock(seconds: number, msSeparator: string): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
  const m = String(Math.floor(ms / 60_000) % 60).padStart(2, '0')
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  return `${h}:${m}:${s}${msSeparator}${String(ms % 1000).padStart(3, '0')}`
}

/** `00:01:02,500` -- SubRip uses a comma before milliseconds. */
export const srtTimestamp = (seconds: number) => clock(seconds, ',')

/** `00:01:02.500` -- WebVTT uses a dot. */
export const vttTimestamp = (seconds: number) => clock(seconds, '.')

/**
 * Speaker labels are a prefix, not a separate field, in the text formats.
 *
 * Plain text uses `SPEAKER_00: …`, the transcript convention. Subtitles use
 * `[SPEAKER_00] …` on the cue's own line, which every player renders and none
 * misreads as dialogue. Undiarized segments carry no prefix at all rather than
 * an "unknown speaker" that was never claimed.
 */
const withSpeaker = (segment: { speaker?: string; text: string }, open: string, close: string) =>
  segment.speaker ? `${open}${segment.speaker}${close} ${segment.text}` : segment.text

export function renderText(transcript: Transcript): Rendered {
  const body = transcript.segments
    .filter((segment) => segment.text)
    .map((segment) => withSpeaker(segment, '', ':'))
    .join('\n')
  return { body, contentType: 'text/plain; charset=utf-8' }
}

export function renderSrt(transcript: Transcript): Rendered {
  const body = transcript.segments
    .filter((segment) => segment.text)
    .map(
      (segment, i) =>
        `${i + 1}\n${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}\n` +
        `${withSpeaker(segment, '[', ']')}\n`,
    )
    .join('\n')
  return { body, contentType: 'text/plain; charset=utf-8' }
}

export function renderVtt(transcript: Transcript): Rendered {
  const cues = transcript.segments
    .filter((segment) => segment.text)
    .map(
      (segment) =>
        `${vttTimestamp(segment.start)} --> ${vttTimestamp(segment.end)}\n` +
        `${withSpeaker(segment, '[', ']')}\n`,
    )
    .join('\n')
  return { body: `WEBVTT\n\n${cues}`, contentType: 'text/vtt; charset=utf-8' }
}

/** The whole transcript, hexscribe's own shape: engine, model, timing, segments. */
export function renderJson(transcript: Transcript): Rendered {
  return { body: JSON.stringify(transcript, null, 2), contentType: 'application/json; charset=utf-8' }
}

export const FORMATS: Record<FormatName, (transcript: Transcript) => Rendered> = {
  text: renderText,
  srt: renderSrt,
  vtt: renderVtt,
  json: renderJson,
}

export function isFormatName(value: string): value is FormatName {
  return (FORMAT_NAMES as readonly string[]).includes(value)
}

export function render(transcript: Transcript, format: FormatName): Rendered {
  return FORMATS[format](transcript)
}
