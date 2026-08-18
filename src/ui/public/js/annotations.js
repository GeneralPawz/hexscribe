/**
 * What a person added to a recording: sections, comments, tags.
 *
 * The machine produces utterances; everything here is somebody's reading of
 * them, and it is the expensive half. A transcript can be made again in four
 * minutes of NPU. An hour spent marking up where the useful part of an
 * interview is cannot be made again at all.
 *
 * All of it is anchored to *when* something was said rather than to which row
 * it is. Merging two utterances renumbers every one after them, and an
 * annotation that slid onto a different sentence because something above it was
 * tidied up would be worse than none: it would still look right.
 *
 * These are pure functions over plain data, so they are tested without a
 * browser. The DOM half lives in `transcript.js` and `timeline.js`.
 */

/** The anchor, at millisecond precision. Must match `at()` in `store.ts`. */
export function at(seconds) {
  return Math.round(seconds * 1000) / 1000
}

/** An empty set, for a run nobody has touched yet. */
export const NOTHING = { sections: [], notes: [], tags: [] }

/**
 * Sections as stretches rather than points.
 *
 * A section starts at an utterance and runs until the next one starts, so a
 * recording is covered without gaps or overlaps — which is what makes the band
 * on the timeline meaningful, and what makes "which section is this line in" a
 * question with one answer.
 *
 * Anything before the first section belongs to no section. That is deliberate:
 * marking up the middle of a recording should not silently claim the beginning.
 *
 * @param {Array<{start: number, title: string}>} sections
 * @param {number} duration total seconds; the last section runs to here
 */
export function spans(sections, duration) {
  const ordered = [...sections].sort((a, b) => a.start - b.start)
  return ordered.map((section, index) => ({
    start: section.start,
    end: index + 1 < ordered.length ? ordered[index + 1].start : Math.max(duration, section.start),
    title: section.title,
  }))
}

/** The section a moment falls in, or undefined before the first one. */
export function spanAt(sections, duration, seconds) {
  return spans(sections, duration).find((span) => seconds >= span.start && seconds < span.end)
}

/** Where a section begins, as a row index. -1 when nothing matches. */
export function rowOf(segments, start) {
  const anchor = at(start)
  return segments.findIndex((segment) => at(segment.start) === anchor)
}

/** The comment on an utterance, if it has one. */
export function noteAt(notes, start) {
  const anchor = at(start)
  return notes.find((note) => at(note.start) === anchor)?.body ?? ''
}

/** The tags on an utterance, in the order they read best: alphabetical. */
export function tagsAt(tags, start) {
  const anchor = at(start)
  return tags
    .filter((entry) => at(entry.start) === anchor)
    .map((entry) => entry.tag)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The tags used in this run, most used first.
 *
 * Separate from the library because they answer different questions: this one
 * is "what is this recording about", the library is "what words do I already
 * use". Both are shown, because tagging with a near-duplicate of an existing
 * word is the failure that makes a vocabulary useless.
 */
export function tagsInRun(tags) {
  const counts = new Map()
  for (const { tag } of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, uses]) => ({ name, uses }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
}

/** Every utterance carrying a tag, as row indices into the transcript. */
export function rowsWithTag(segments, tags, tag) {
  const starts = new Set(tags.filter((entry) => entry.tag === tag).map((entry) => at(entry.start)))
  const rows = []
  segments.forEach((segment, index) => {
    if (starts.has(at(segment.start))) rows.push(index)
  })
  return rows
}

/** Rows carrying any tag at all, for the marks in the margin. */
export function taggedRows(segments, annotations) {
  const tagged = new Set(annotations.tags.map((entry) => at(entry.start)))
  const noted = new Set(annotations.notes.map((entry) => at(entry.start)))
  const marks = new Map()
  segments.forEach((segment, index) => {
    const anchor = at(segment.start)
    if (tagged.has(anchor) || noted.has(anchor)) {
      marks.set(index, { tagged: tagged.has(anchor), noted: noted.has(anchor) })
    }
  })
  return marks
}
