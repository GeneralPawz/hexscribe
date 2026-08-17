import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './asr.ts'
import type {} from './diarize.ts'
import type {} from './voices.ts'
import type { Segment, SpeakerVoice, Transcript } from './asr.ts'
import type { DiarizeResult, Turn } from './diarize.ts'

export interface Config {
  threshold?: number
  engine?: string
}

export const Config: Schema<Config> = Schema.object({
  threshold: Schema.number().description('Clustering threshold; lower finds more speakers. Omit for 0.5.'),
  engine: Schema.string().description('Diarization engine name; omit when only one is loaded.'),
})

/**
 * Overlap in seconds between an utterance and a speaker turn.
 *
 * Exported because it is the whole attribution rule, and a rule this small is
 * better pinned by a test than explained in a comment.
 */
export function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

/**
 * Give each utterance the speaker it shares most time with.
 *
 * Whisper's utterances and pyannote's turns are cut on different criteria, so
 * they do not line up: an utterance can span a speaker change, and turns can
 * overlap where people talk at once. Without word-level timings the honest
 * choice is the dominant speaker per utterance rather than splitting text at a
 * boundary we cannot locate inside the words. An utterance overlapping nothing
 * keeps no speaker at all — better an absent label than a guessed one.
 */
export function attribute(segments: Segment[], turns: Turn[]): Segment[] {
  return segments.map((segment) => {
    const totals = new Map<string, number>()
    for (const turn of turns) {
      const shared = overlap(segment, turn)
      if (shared > 0) totals.set(turn.speaker, (totals.get(turn.speaker) ?? 0) + shared)
    }
    let best: string | undefined
    let bestShare = 0
    for (const [speaker, shared] of totals) {
      if (shared > bestShare) {
        best = speaker
        bestShare = shared
      }
    }
    return best ? { ...segment, speaker: best } : segment
  })
}

/**
 * Attaches speakers to a finished transcript, when the request asked for them.
 *
 * A `transcript/finalize` listener like the glossary — it delegates first, then
 * annotates what comes back. The ASR engine has no idea this exists, and the
 * diarizer never sees a transcript.
 */
export const name = 'speakers'
export const inject = ['diarize']

export function apply(ctx: Context, config: Config) {
  ctx.on('transcript/finalize', async (_transcript, request, next) => {
    const result: Transcript = await next()
    if (!request.diarize) return result

    const { turns, timing, profiles } = await ctx.diarize.run({
      path: request.path,
      threshold: request.speakerThreshold ?? config.threshold,
      engine: config.engine,
      // Offered, not required: an engine that segments the audio itself ignores
      // these, and one that clusters utterances cannot work without them.
      utterances: result.segments.map(({ start, end }) => ({ start, end })),
    })

    const attributed = attribute(result.segments, turns)
    const { segments, voices } = await recognise(ctx, attributed, profiles)

    return {
      ...result,
      segments,
      speakers: [...new Set(segments.map((segment) => segment.speaker).filter(Boolean))].sort() as string[],
      ...(voices.length ? { voices } : {}),
      timing: { ...result.timing, diarize_ms: timing.total_ms },
    }
  })
}

/**
 * Put names to the numbers, where this machine has been told any.
 *
 * `SPEAKER_00` is an ordinal, not an identity — it means "whoever spoke first in
 * this file", so the same person is `SPEAKER_00` in one recording and
 * `SPEAKER_02` in the next. The `voices` service holds the prints of people
 * somebody has named, and a match replaces the ordinal with the name everywhere
 * it appears.
 *
 * Looked up rather than injected, and that distinction is load-bearing. Cordis
 * has one kind of dependency: a plugin that declares `inject: ['voices']` does
 * not run at all until a voice library exists. That is right for `diarize`,
 * which this plugin cannot do its job without, and wrong for `voices`, which is
 * an enhancement — no library should mean numbered speakers, not a transcript
 * with no speakers in it. `reflect.get` answers "is it there?" without the
 * assertion that reading `ctx.voices` would make.
 */
async function recognise(
  ctx: Context,
  segments: Segment[],
  profiles: DiarizeResult['profiles'],
): Promise<{ segments: Segment[]; voices: SpeakerVoice[] }> {
  const voices: SpeakerVoice[] = (profiles ?? []).map((profile) => ({ ...profile }))
  const library: Context['voices'] | undefined = ctx.reflect.get('voices')
  if (!voices.length || !library) return { segments, voices }

  const renames = new Map<string, string>()
  const taken = new Set<string>()
  for (const voice of voices) {
    const match = await library.match(voice.embedding)
    // One stored voice cannot be two speakers in the same recording: if it
    // already claimed one, the second is left as a number rather than being
    // given a name that is now certainly wrong for one of them.
    if (!match || taken.has(match.name)) continue
    taken.add(match.name)
    voice.matched = { name: match.name, distance: match.distance }
    renames.set(voice.speaker, match.name)
  }
  if (!renames.size) return { segments, voices }

  for (const voice of voices) voice.speaker = renames.get(voice.speaker) ?? voice.speaker
  return {
    segments: segments.map((segment) =>
      segment.speaker && renames.has(segment.speaker)
        ? { ...segment, speaker: renames.get(segment.speaker) }
        : segment,
    ),
    voices,
  }
}
