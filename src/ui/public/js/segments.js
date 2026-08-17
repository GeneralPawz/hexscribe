/**
 * Editing a transcript's utterance boundaries.
 *
 * Whisper cuts at decode-window edges, not at sentence ends, so a sentence that
 * straddles a window arrives as two utterances — "…bei dem Lehrstuhl" followed
 * by "Baubetrieb und Bauverfahren in Weimar". Joining those is the same
 * operation whether a person clicks *merge* or the automatic pass decides to;
 * only the decision differs.
 *
 * So the operations live here, as pure functions over a segment array, and both
 * callers use them: `src/postproc-merge.ts` (the Cordis plugin, which imports
 * this file directly) and the browser UI (which is served it). One
 * implementation, or the two would drift.
 *
 * Plain JavaScript rather than TypeScript because the browser is served this
 * file as-is; there is no build step in this project.
 */

/**
 * @typedef {object} Segment
 * @property {number} index positional; renumbered after every edit
 * @property {number} start seconds
 * @property {number} end seconds
 * @property {string} text
 * @property {string} [speaker] present only when diarization ran
 * @property {boolean} [edited] set when a person corrected the text by hand
 */

/**
 * @typedef {object} MergeOptions
 * @property {number} maxGap
 * @property {number} maxChars
 * @property {number} maxSeconds
 */

/** Trailing marks that do not themselves end a sentence, e.g. `sagte er."` */
const TRAILING = /["'»«”’)\]\s]+$/

/**
 * Does this text end on a finished sentence?
 *
 * The question the automatic pass asks. `:` counts as unfinished on purpose —
 * "und zwar:" continues into whatever follows.
 *
 * @param {string} text @returns {boolean}
 */
export function endsSentence(text) {
  const trimmed = String(text ?? '').replace(TRAILING, '')
  return /[.!?…]$/.test(trimmed)
}

/**
 * Renumber: indices are positional and must stay that way.
 *
 * @param {Segment[]} segments @returns {Segment[]}
 */
function reindex(segments) {
  return segments.map((segment, index) => ({ ...segment, index }))
}

/**
 * Join segment `index` with the one after it.
 *
 * The merged utterance spans from the first start to the second end, and keeps
 * the first speaker: a manual merge across a speaker change is the user saying
 * the diarizer was wrong about the second half, not about the first.
 *
 * @param {Segment[]} segments @param {number} index @returns {Segment[]}
 */
export function mergeAt(segments, index) {
  const a = segments[index]
  const b = segments[index + 1]
  if (!a || !b) return segments

  const merged = {
    ...a,
    start: a.start,
    end: b.end,
    text: `${a.text.trim()} ${b.text.trim()}`.trim(),
  }
  return reindex([...segments.slice(0, index), merged, ...segments.slice(index + 2)])
}

/**
 * When a character offset in an utterance is spoken.
 *
 * Interpolated by character position, which assumes an even speaking rate across
 * the utterance. That is wrong in detail and close enough to click on — the
 * alternative is word-level timings the model does not give us.
 *
 * Two callers, one approximation: `splitAt` puts a boundary here, and the row
 * menu plays from here. If they disagreed, a split would land somewhere other
 * than where playback had just told the user the words were.
 *
 * @param {Segment} segment @param {number} charOffset @returns {number} seconds
 */
export function timeAt(segment, charOffset) {
  const length = segment.text.length
  if (!length) return segment.start
  const fraction = Math.max(0, Math.min(length, charOffset)) / length
  return Number((segment.start + (segment.end - segment.start) * fraction).toFixed(2))
}

/**
 * Split segment `index` at a character offset in its text.
 *
 * @param {Segment[]} segments @param {number} index @param {number} charOffset @returns {Segment[]}
 */
export function splitAt(segments, index, charOffset) {
  const segment = segments[index]
  if (!segment) return segments

  const text = segment.text
  const cut = Math.max(0, Math.min(text.length, charOffset))
  const head = text.slice(0, cut).trim()
  const tail = text.slice(cut).trim()
  if (!head || !tail) return segments // a split that produces nothing is not a split

  const boundary = timeAt(segment, cut)

  return reindex([
    ...segments.slice(0, index),
    { ...segment, end: boundary, text: head },
    { ...segment, start: boundary, text: tail },
    ...segments.slice(index + 1),
  ])
}

/**
 * Join a contiguous run of utterances into one.
 *
 * What a multi-row selection merges to. Equivalent to repeating `mergeAt`, but
 * expressed as one operation so it is one undo step, not several.
 *
 * @param {Segment[]} segments @param {number} from @param {number} to @returns {Segment[]}
 */
export function mergeRange(segments, from, to) {
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(segments.length - 1, Math.max(from, to))
  if (end <= start) return segments

  const group = segments.slice(start, end + 1)
  const merged = {
    ...group[0],
    end: group[group.length - 1].end,
    text: group
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(' '),
  }
  return reindex([...segments.slice(0, start), merged, ...segments.slice(end + 1)])
}

/**
 * Replace an utterance's text, leaving its timing alone.
 *
 * Correcting what the model misheard. Empty is refused rather than treated as a
 * delete: removing an utterance is a different intent and should say so.
 *
 * @param {Segment[]} segments @param {number} index @param {string} text @returns {Segment[]}
 */
export function setText(segments, index, text) {
  const segment = segments[index]
  const next = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!segment || !next || next === segment.text) return segments

  return [
    ...segments.slice(0, index),
    { ...segment, text: next, edited: true },
    ...segments.slice(index + 1),
  ]
}

/**
 * Are these positions one unbroken run?
 *
 * Merging a selection only means something for neighbours; picking rows 1 and 4
 * and joining them would silently swallow 2 and 3.
 *
 * @param {number[]} positions @returns {boolean}
 */
export function isContiguous(positions) {
  if (positions.length < 2) return false
  const sorted = [...positions].sort((a, b) => a - b)
  return sorted.every((value, i) => i === 0 || value === sorted[i - 1] + 1)
}

/**
 * Assign (or clear) the speaker on a set of rows.
 *
 * Diarization guesses; a person knows. Passing `null` removes the label rather
 * than inventing an "unknown" speaker, and the timing and text are untouched —
 * this only answers *who*.
 *
 * @param {Segment[]} segments @param {number[]} positions @param {string | null} speaker
 * @returns {Segment[]}
 */
export function setSpeaker(segments, positions, speaker) {
  const targets = new Set(positions)
  if (!targets.size) return segments

  let changed = false
  const next = segments.map((segment, position) => {
    if (!targets.has(position)) return segment
    const current = segment.speaker ?? null
    if (current === speaker) return segment
    changed = true
    const { speaker: _drop, ...rest } = segment
    return speaker ? { ...rest, speaker } : rest
  })
  return changed ? next : segments
}

/**
 * Distinct speakers, in the order they first speak.
 *
 * @param {Segment[]} segments @returns {string[]}
 */
export function speakerNames(segments) {
  const seen = []
  for (const segment of segments) {
    if (segment.speaker && !seen.includes(segment.speaker)) seen.push(segment.speaker)
  }
  return seen
}

/**
 * Everything one speaker said, with where to find it.
 *
 * @param {Segment[]} segments @param {string} speaker
 * @returns {{ position: number, segment: Segment }[]}
 */
export function utterancesOf(segments, speaker) {
  const found = []
  segments.forEach((segment, position) => {
    if (segment.speaker === speaker) found.push({ position, segment })
  })
  return found
}

/**
 * How much each speaker said, in the order they first speak.
 *
 * @param {Segment[]} segments
 * @returns {{ name: string, utterances: number, seconds: number, first: number }[]}
 */
export function speakerSummary(segments) {
  const seen = new Map()
  segments.forEach((segment, position) => {
    if (!segment.speaker) return
    const entry = seen.get(segment.speaker) ?? {
      name: segment.speaker,
      utterances: 0,
      seconds: 0,
      first: position,
    }
    entry.utterances += 1
    entry.seconds += Math.max(0, segment.end - segment.start)
    seen.set(segment.speaker, entry)
  })
  return [...seen.values()]
}

/**
 * Make several speakers one.
 *
 * Diarization splits a person more often than it merges two, and on a long
 * recording it splits them a lot — one voice heard across an hour drifts, and a
 * clustering strict enough to keep two people apart is strict enough to cut one
 * person into pieces. Rejoining them is a judgement only a listener can make,
 * so it is an operation rather than a parameter.
 *
 * @param {Segment[]} segments @param {string[]} names @param {string} into
 * @returns {Segment[]}
 */
export function mergeSpeakers(segments, names, into) {
  const absorbed = new Set(names.filter((name) => name && name !== into))
  if (!absorbed.size) return segments

  let changed = false
  const next = segments.map((segment) => {
    if (!segment.speaker || !absorbed.has(segment.speaker)) return segment
    changed = true
    return { ...segment, speaker: into }
  })
  return changed ? next : segments
}

/**
 * One voice print from several, weighted by how much speech is behind each.
 *
 * The reason merging speakers is worth doing at all beyond tidying the page: a
 * print built from four fragments of the same person is a better description of
 * them than any one fragment, and it is what the next recording is matched
 * against. An hour of somebody, split six ways by the clustering and rejoined by
 * hand, produces a better print than a clean thirty-second sample would.
 *
 * @param {{embedding: number[], seconds: number}[]} voices
 * @returns {{embedding: number[], seconds: number} | null}
 */
export function blendVoices(voices) {
  const usable = voices.filter((voice) => voice?.embedding?.length)
  if (!usable.length) return null

  const size = usable[0].embedding.length
  const total = new Array(size).fill(0)
  let seconds = 0
  for (const voice of usable) {
    if (voice.embedding.length !== size) continue // a different model; not comparable
    const weight = voice.seconds > 0 ? voice.seconds : 1
    for (let i = 0; i < size; i++) total[i] += voice.embedding[i] * weight
    seconds += voice.seconds ?? 0
  }

  const norm = Math.hypot(...total)
  if (!norm) return null
  return { embedding: total.map((value) => value / norm), seconds }
}

/**
 * Merge speakers in a whole transcript, prints included.
 *
 * Kept together because doing one without the other leaves a transcript whose
 * labels and voice prints disagree — and the prints are what a name is stored
 * against, so a stale one gets the wrong person recognised later.
 *
 * @param {object} transcript @param {string[]} names @param {string} into
 */
export function mergeSpeakersInTranscript(transcript, names, into) {
  const segments = mergeSpeakers(transcript.segments, names, into)
  if (segments === transcript.segments) return transcript

  const absorbed = new Set(names.filter((name) => name !== into))
  const involved = (transcript.voices ?? []).filter(
    (voice) => voice.speaker === into || absorbed.has(voice.speaker),
  )
  const blended = blendVoices(involved)

  const voices = (transcript.voices ?? [])
    .filter((voice) => !absorbed.has(voice.speaker))
    .map((voice) =>
      voice.speaker === into && blended
        ? {
            ...voice,
            embedding: blended.embedding,
            seconds: blended.seconds,
            utterances: involved.reduce((sum, entry) => sum + (entry.utterances ?? 0), 0),
            // Whatever it was recognised as was recognised from a print that no
            // longer exists. Claiming the match still holds would be a guess.
            matched: undefined,
          }
        : voice,
    )

  return {
    ...transcript,
    segments,
    speakers: [...new Set(segments.map((segment) => segment.speaker).filter(Boolean))].sort(),
    ...(transcript.voices ? { voices } : {}),
  }
}

/**
 * The next unused `SPEAKER_NN`.
 *
 * Numbered rather than named because a name would be a guess; renaming people
 * is a separate feature that needs somewhere to store the names.
 *
 * @param {Segment[]} segments @returns {string}
 */
export function nextSpeakerName(segments) {
  const used = new Set(speakerNames(segments))
  for (let n = 0; n < 100; n++) {
    const name = `SPEAKER_${String(n).padStart(2, '0')}`
    if (!used.has(name)) return name
  }
  return `SPEAKER_${used.size}`
}

export const MERGE_DEFAULTS = {
  /**
   * Seconds of silence that still count as the same sentence continuing.
   *
   * Generous on purpose. Whisper marks where speech stops, and the next window
   * starts where the seek put it, so a boundary inside one sentence routinely
   * shows a second of "silence" that was never a pause — the case this whole
   * pass exists for measured 1.12 s. Punctuation is the real signal; this only
   * has to rule out joining across an obvious break.
   */
  maxGap: 1.5,
  /** Stop merging before an utterance becomes an unreadable wall of text. */
  maxChars: 320,
  /** And a sanity cap, so nothing runs away. */
  maxSeconds: 60,
}

/**
 * Should these two be one utterance?
 *
 * The signal that matters is punctuation: Whisper punctuates what it hears, so
 * an utterance that ends without a full stop was cut off rather than finished.
 * Everything else here is a guard against merging things that only *look*
 * continuous — a long pause, a different speaker, or a result so long it stops
 * being a subtitle.
 *
 * @param {Segment} a @param {Segment} b @param {MergeOptions} [options] @returns {boolean}
 */
export function shouldMerge(a, b, options = MERGE_DEFAULTS) {
  if (!a || !b) return false
  if (a.speaker && b.speaker && a.speaker !== b.speaker) return false
  if (endsSentence(a.text)) return false
  if (b.start - a.end > options.maxGap) return false
  if (a.text.length + b.text.length + 1 > options.maxChars) return false
  if (b.end - a.start > options.maxSeconds) return false
  return true
}

/**
 * Join every pair the rule accepts, left to right.
 *
 * Merging is applied repeatedly to the growing utterance, so three fragments of
 * one sentence collapse into one — but each step is checked again, so the
 * guards still hold at the end.
 *
 * @param {Segment[]} segments @param {Partial<MergeOptions>} [options] @returns {Segment[]}
 */
export function smartMerge(segments, options = MERGE_DEFAULTS) {
  const settings = { ...MERGE_DEFAULTS, ...options }
  const out = []
  for (const segment of segments) {
    const previous = out[out.length - 1]
    if (previous && shouldMerge(previous, segment, settings)) {
      out[out.length - 1] = {
        ...previous,
        end: segment.end,
        text: `${previous.text.trim()} ${segment.text.trim()}`.trim(),
      }
    } else {
      out.push({ ...segment })
    }
  }
  return reindex(out)
}
