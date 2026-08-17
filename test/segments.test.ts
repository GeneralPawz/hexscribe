/**
 * Merging and splitting utterances.
 *
 * These operations run in two places — a person clicking *merge* in the browser
 * and the automatic pass on the server — and both call this one module, so a
 * rule that is wrong here is wrong twice. The automatic pass is the riskier of
 * the two: it edits a transcript nobody asked it to touch, so most of what is
 * pinned below is when it must *decline*.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  endsSentence,
  isContiguous,
  mergeAt,
  mergeRange,
  nextSpeakerName,
  setSpeaker,
  setText,
  speakerNames,
  shouldMerge,
  smartMerge,
  splitAt,
  timeAt,
  blendVoices,
  mergeSpeakers,
  mergeSpeakersInTranscript,
  speakerSummary,
  utterancesOf,
  MERGE_DEFAULTS,
} from '../src/ui/public/js/segments.js'

const seg = (index: number, start: number, end: number, text: string, speaker?: string) => ({
  index,
  start,
  end,
  text,
  ...(speaker ? { speaker } : {}),
})

// The case that prompted all this: one sentence, cut at a decode window edge.
const SPLIT_SENTENCE = [
  seg(0, 0, 15, 'Alles klar. Vielen Dank für die Vorstellung. Ich selbst bin jetzt seit drei Jahren bei dem Lehrstuhl'),
  seg(1, 15, 22, 'Baubetrieb und Bauverfahren in Weimar, als wissenschaftlicher Mitarbeiter.'),
]

test('a sentence cut at a window boundary is rejoined', () => {
  const merged = smartMerge(SPLIT_SENTENCE)

  assert.equal(merged.length, 1)
  assert.match(merged[0].text, /bei dem Lehrstuhl Baubetrieb und Bauverfahren in Weimar/)
  assert.equal(merged[0].start, 0)
  assert.equal(merged[0].end, 22)
  assert.equal(merged[0].index, 0)
})

test('punctuation is the signal: a finished sentence is left alone', () => {
  assert.ok(endsSentence('Das war es.'))
  assert.ok(endsSentence('Wirklich?'))
  assert.ok(endsSentence('Und dann…'))
  assert.ok(endsSentence('"Das war es."'), 'trailing quotes do not hide the full stop')
  assert.ok(!endsSentence('bei dem Lehrstuhl'))
  assert.ok(!endsSentence('und zwar:'), 'a colon continues into what follows')

  const finished = [seg(0, 0, 5, 'Das war es.'), seg(1, 5, 9, 'Danach kam nichts mehr.')]
  assert.equal(smartMerge(finished).length, 2)
})

test('the automatic pass declines when continuing is not the obvious reading', () => {
  const unfinished = (gap: number) => [seg(0, 0, 5, 'und dann'), seg(1, 5 + gap, 9 + gap, 'kam er')]

  assert.equal(smartMerge(unfinished(0.2)).length, 1, 'a breath apart is one sentence')
  assert.equal(
    smartMerge(unfinished(1.12)).length,
    1,
    'the measured gap at a window boundary, which is an artefact rather than a pause',
  )
  assert.equal(smartMerge(unfinished(5)).length, 2, 'five seconds apart is not')

  const differentSpeakers = [seg(0, 0, 5, 'und dann', 'SPEAKER_00'), seg(1, 5, 9, 'kam er', 'SPEAKER_01')]
  assert.equal(smartMerge(differentSpeakers).length, 2, 'never across a speaker change')

  const long = [seg(0, 0, 5, 'a'.repeat(300)), seg(1, 5, 9, 'b'.repeat(300))]
  assert.equal(smartMerge(long).length, 2, 'not into a wall of text')

  const slow = [seg(0, 0, 55, 'und dann'), seg(1, 55, 80, 'kam er')]
  assert.equal(smartMerge(slow).length, 2, 'not past the runaway cap')
})

test('three fragments of one sentence collapse into one', () => {
  const fragments = [
    seg(0, 0, 5, 'Ich selbst bin jetzt'),
    seg(1, 5, 10, 'seit drei Jahren'),
    seg(2, 10, 15, 'bei dem Lehrstuhl.'),
  ]

  const merged = smartMerge(fragments)

  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, 'Ich selbst bin jetzt seit drei Jahren bei dem Lehrstuhl.')
  assert.equal(merged[0].end, 15)
})

test('but the guards still hold after repeated merging', () => {
  // Each pair is close enough, yet the result would exceed the length limit.
  const fragments = [seg(0, 0, 5, 'a'.repeat(200)), seg(1, 5, 10, 'b'.repeat(100)), seg(2, 10, 15, 'c'.repeat(100))]

  const merged = smartMerge(fragments)

  assert.equal(merged.length, 2)
  assert.ok(merged[0].text.length <= MERGE_DEFAULTS.maxChars)
})

test('a manual merge joins exactly two, whatever the rule thinks', () => {
  // The point of doing it by hand: the user has overruled the heuristic.
  const finished = [seg(0, 0, 5, 'Das war es.'), seg(1, 30, 40, 'Etwas ganz anderes.', 'SPEAKER_01')]

  const merged = mergeAt(finished, 0)

  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, 'Das war es. Etwas ganz anderes.')
  assert.equal(merged[0].start, 0)
  assert.equal(merged[0].end, 40)
})

test('merging the last row, or past the end, changes nothing', () => {
  const one = [seg(0, 0, 5, 'allein')]
  assert.equal(mergeAt(one, 0), one)
  assert.equal(mergeAt(one, 7), one)
})

test('splitting divides the text and interpolates the boundary time', () => {
  const segments = [seg(0, 10, 20, 'erster Teil zweiter Teil')]
  const offset = 'erster Teil'.length

  const split = splitAt(segments, 0, offset)

  assert.equal(split.length, 2)
  assert.equal(split[0].text, 'erster Teil')
  assert.equal(split[1].text, 'zweiter Teil')
  assert.equal(split[0].end, split[1].start, 'no gap and no overlap at the seam')
  assert.ok(split[0].end > 10 && split[0].end < 20)
  assert.deepEqual(
    split.map((s) => s.index),
    [0, 1],
    'indices are positional, so they are renumbered',
  )
})

test('a character offset maps to a time, the same one for a split and for playback', () => {
  // *Play from here* and *Split here* both ask "when is this word spoken?", and
  // an answer that differed between them would put a boundary somewhere other
  // than where playback had just said the words were.
  const segment = seg(0, 10, 20, 'erster Teil zweiter Teil')

  assert.equal(timeAt(segment, 0), 10, 'the start of the text is the start of the utterance')
  assert.equal(timeAt(segment, segment.text.length), 20, 'and the end is the end')
  assert.equal(timeAt(segment, 12), 15, 'halfway through the characters, halfway through the time')

  assert.equal(timeAt(segment, -5), 10, 'an offset off either end is clamped')
  assert.equal(timeAt(segment, 999), 20)
  assert.equal(timeAt(seg(0, 4, 9, ''), 3), 4, 'an empty utterance has only its start')

  const split = splitAt([segment], 0, 12)
  assert.equal(split[0].end, timeAt(segment, 12), 'the split boundary is this same answer')
})

test('a split that would produce an empty side is refused', () => {
  const segments = [seg(0, 0, 10, 'nur ein Satz')]

  // Same array back, not a copy: nothing happened, so nothing re-renders.
  assert.equal(splitAt(segments, 0, 0), segments, 'before the first character')
  assert.equal(splitAt(segments, 0, 999), segments, 'past the last')
  assert.equal(splitAt(segments, 0, 3).length, 2, 'but a real offset does split')
})

test('a split keeps the speaker on both halves', () => {
  const segments = [seg(0, 0, 10, 'erster Teil zweiter Teil', 'SPEAKER_02')]

  const split = splitAt(segments, 0, 'erster Teil'.length)

  assert.equal(split[0].speaker, 'SPEAKER_02')
  assert.equal(split[1].speaker, 'SPEAKER_02')
})

test('split then merge returns the original text', () => {
  const original = [seg(0, 0, 10, 'erster Teil zweiter Teil')]

  const round = mergeAt(splitAt(original, 0, 11), 0)

  assert.equal(round.length, 1)
  assert.equal(round[0].text, original[0].text)
  assert.equal(round[0].start, 0)
  assert.equal(round[0].end, 10)
})

test('shouldMerge is the whole rule, and says so', () => {
  const a = seg(0, 0, 5, 'und dann')
  assert.ok(shouldMerge(a, seg(1, 5, 9, 'kam er')))
  assert.ok(!shouldMerge(a, undefined as never))
  assert.ok(!shouldMerge(undefined as never, a))
})

// --- what the Ctrl+click selection and the context menu call ---------------

test('a selected run merges into one, in a single step', () => {
  const segments = [
    seg(0, 0, 5, 'Ich selbst bin jetzt'),
    seg(1, 5, 10, 'seit drei Jahren'),
    seg(2, 10, 15, 'bei dem Lehrstuhl.'),
    seg(3, 15, 20, 'Etwas anderes.'),
  ]

  const merged = mergeRange(segments, 0, 2)

  assert.equal(merged.length, 2)
  assert.equal(merged[0].text, 'Ich selbst bin jetzt seit drei Jahren bei dem Lehrstuhl.')
  assert.equal(merged[0].start, 0)
  assert.equal(merged[0].end, 15)
  assert.equal(merged[1].text, 'Etwas anderes.')
  // One operation, so one undo step -- not three.
  assert.deepEqual(merged.map((s) => s.index), [0, 1])
})

test('a range takes its ends in either order, and refuses a range of one', () => {
  const segments = [seg(0, 0, 5, 'a'), seg(1, 5, 10, 'b')]

  assert.equal(mergeRange(segments, 1, 0).length, 1, 'reversed is the same range')
  assert.equal(mergeRange(segments, 0, 0), segments, 'a single row is not a merge')
  assert.equal(mergeRange(segments, 5, 9), segments, 'out of range changes nothing')
})

test('only an unbroken run can merge', () => {
  assert.ok(isContiguous([2, 3, 4]))
  assert.ok(isContiguous([4, 2, 3]), 'order of selection does not matter')
  assert.ok(!isContiguous([1, 3]), 'merging these would swallow row 2')
  assert.ok(!isContiguous([1]))
  assert.ok(!isContiguous([]))
})

test('editing replaces the words and leaves the timing alone', () => {
  const segments = [seg(0, 3, 9, 'Wer zum Beispiel einen Kollegen bekommen der war.')]

  const fixed = setText(segments, 0, 'Wer zum Beispiel einen Kollegen bekommen hat, der war…')

  assert.equal(fixed[0].text, 'Wer zum Beispiel einen Kollegen bekommen hat, der war…')
  assert.equal(fixed[0].start, 3)
  assert.equal(fixed[0].end, 9)
  assert.equal(fixed[0].edited, true, 'marked, so a correction is not mistaken for what was heard')
})

test('an edit that changes nothing, or empties the line, is not an edit', () => {
  const segments = [seg(0, 0, 5, 'unverändert')]

  assert.equal(setText(segments, 0, 'unverändert'), segments, 'identical text')
  assert.equal(setText(segments, 0, '   '), segments, 'whitespace only')
  assert.equal(setText(segments, 0, ''), segments, 'empty is not a delete')
  assert.equal(setText(segments, 9, 'nope'), segments, 'no such row')
  assert.equal(setText(segments, 0, '  zwei   Wörter  ')[0].text, 'zwei Wörter', 'but whitespace is tidied')
})

// --- who was speaking -----------------------------------------------------

test('a speaker can be assigned to several rows at once', () => {
  const segments = [seg(0, 0, 5, 'a'), seg(1, 5, 10, 'b'), seg(2, 10, 15, 'c')]

  const labelled = setSpeaker(segments, [0, 2], 'SPEAKER_01')

  assert.deepEqual(
    labelled.map((s) => s.speaker),
    ['SPEAKER_01', undefined, 'SPEAKER_01'],
  )
  assert.equal(labelled[0].text, 'a', 'text and timing are untouched')
  assert.equal(labelled[0].end, 5)
})

test('clearing removes the label rather than inventing an unknown speaker', () => {
  const segments = [seg(0, 0, 5, 'a', 'SPEAKER_00'), seg(1, 5, 10, 'b', 'SPEAKER_01')]

  const cleared = setSpeaker(segments, [0], null)

  assert.ok(!('speaker' in cleared[0]), 'the property is gone, not set to null')
  assert.equal(cleared[1].speaker, 'SPEAKER_01', 'and the others keep theirs')
})

test('a speaker change that changes nothing is not an edit', () => {
  // Same array back means no history entry and no re-render.
  const labelled = [seg(0, 0, 5, 'a', 'SPEAKER_00')]
  assert.equal(setSpeaker(labelled, [0], 'SPEAKER_00'), labelled, 'same speaker')
  assert.equal(setSpeaker(labelled, [], 'SPEAKER_01'), labelled, 'no rows selected')

  const unlabelled = [seg(0, 0, 5, 'a')]
  assert.equal(setSpeaker(unlabelled, [0], null), unlabelled, 'already unlabelled')
})

test('speakers are listed in the order they first speak', () => {
  const segments = [
    seg(0, 0, 5, 'a', 'SPEAKER_02'),
    seg(1, 5, 10, 'b'),
    seg(2, 10, 15, 'c', 'SPEAKER_00'),
    seg(3, 15, 20, 'd', 'SPEAKER_02'),
  ]

  assert.deepEqual(speakerNames(segments), ['SPEAKER_02', 'SPEAKER_00'])
  assert.deepEqual(speakerNames([seg(0, 0, 5, 'a')]), [])
})

test('a new speaker takes the first free number', () => {
  assert.equal(nextSpeakerName([seg(0, 0, 5, 'a')]), 'SPEAKER_00')
  assert.equal(nextSpeakerName([seg(0, 0, 5, 'a', 'SPEAKER_00')]), 'SPEAKER_01')
  assert.equal(
    nextSpeakerName([seg(0, 0, 5, 'a', 'SPEAKER_00'), seg(1, 5, 9, 'b', 'SPEAKER_02')]),
    'SPEAKER_01',
    'gaps are filled rather than skipped',
  )
})

// --- speakers: merging several into one -------------------------------

const voiced = (index: number, start: number, end: number, speaker: string) =>
  seg(index, start, end, `t${index}`, speaker)

test('merging speakers reaches every utterance of each', () => {
  // The reason this exists: a 575-utterance interview came out as 45 speakers,
  // and most of them are the same two people.
  const segments = [
    voiced(0, 0, 5, 'SPEAKER_00'),
    voiced(1, 5, 10, 'SPEAKER_03'),
    voiced(2, 10, 15, 'SPEAKER_07'),
    voiced(3, 15, 20, 'SPEAKER_01'),
  ]

  const merged = mergeSpeakers(segments, ['SPEAKER_03', 'SPEAKER_07'], 'SPEAKER_00')

  assert.deepEqual(
    merged.map((entry) => entry.speaker),
    ['SPEAKER_00', 'SPEAKER_00', 'SPEAKER_00', 'SPEAKER_01'],
  )
  assert.equal(segments[1].speaker, 'SPEAKER_03', 'the original is untouched')
})

test('a merge that changes nothing returns the same array', () => {
  const segments = [voiced(0, 0, 5, 'SPEAKER_00')]

  assert.equal(mergeSpeakers(segments, ['SPEAKER_00'], 'SPEAKER_00'), segments, 'into itself')
  assert.equal(mergeSpeakers(segments, [], 'SPEAKER_00'), segments, 'nothing named')
  assert.equal(mergeSpeakers(segments, ['SPEAKER_09'], 'SPEAKER_00'), segments, 'nobody said that')
})

test('voice prints are blended by how much speech is behind each', () => {
  // Why merging is worth more than tidying the page: the print built from the
  // pieces is what the next recording is matched against.
  const blended = blendVoices([
    { embedding: [1, 0, 0], seconds: 300 },
    { embedding: [0, 1, 0], seconds: 10 },
  ])

  assert.ok(blended)
  assert.ok(blended!.embedding[0] > blended!.embedding[1] * 20, 'the long one dominates')
  assert.equal(blended!.seconds, 310, 'and the evidence adds up')
  assert.ok(Math.abs(Math.hypot(...blended!.embedding) - 1) < 1e-9, 'still a unit vector')
})

test('blending copes with nothing to blend', () => {
  assert.equal(blendVoices([]), null)
  assert.equal(blendVoices([{ embedding: [], seconds: 5 }]), null)
  assert.equal(blendVoices([{ embedding: [0, 0, 0], seconds: 5 }]), null, 'a zero vector has no direction')
})

test('merging a transcript keeps its labels and its prints agreeing', () => {
  // A stale print is worse than none: it is what a name gets stored against,
  // and it would have the wrong person recognised next time.
  const transcript = {
    segments: [voiced(0, 0, 60, 'SPEAKER_00'), voiced(1, 60, 70, 'SPEAKER_02'), voiced(2, 70, 80, 'SPEAKER_01')],
    voices: [
      { speaker: 'SPEAKER_00', embedding: [1, 0, 0], seconds: 60, utterances: 1 },
      { speaker: 'SPEAKER_02', embedding: [0, 1, 0], seconds: 10, utterances: 1, matched: { name: 'Bob', distance: 0.2 } },
      { speaker: 'SPEAKER_01', embedding: [0, 0, 1], seconds: 10, utterances: 1 },
    ],
  }

  const merged = mergeSpeakersInTranscript(transcript as never, ['SPEAKER_02'], 'SPEAKER_00') as never as typeof transcript

  assert.deepEqual(merged.segments.map((s) => s.speaker), ['SPEAKER_00', 'SPEAKER_00', 'SPEAKER_01'])
  assert.equal(merged.voices.length, 2, 'the absorbed print is gone')
  const kept = merged.voices.find((v) => v.speaker === 'SPEAKER_00')!
  assert.equal(kept.seconds, 70, 'and its evidence includes what it absorbed')
  assert.equal(kept.utterances, 2)
  assert.ok(kept.embedding[0] > kept.embedding[1], 'weighted toward the longer half')
  assert.equal(merged.voices.find((v) => v.speaker === 'SPEAKER_02'), undefined)
})

test('a merged speaker stops claiming a recognition it no longer has evidence for', () => {
  const transcript = {
    segments: [voiced(0, 0, 10, 'SPEAKER_00'), voiced(1, 10, 20, 'SPEAKER_01')],
    voices: [
      { speaker: 'SPEAKER_00', embedding: [1, 0, 0], seconds: 10, utterances: 1, matched: { name: 'Mara', distance: 0.3 } },
      { speaker: 'SPEAKER_01', embedding: [0, 1, 0], seconds: 10, utterances: 1 },
    ],
  }

  const merged = mergeSpeakersInTranscript(transcript as never, ['SPEAKER_01'], 'SPEAKER_00') as never as typeof transcript

  assert.equal(merged.voices[0].matched, undefined, 'the print it was matched on no longer exists')
})

test('a speaker summary says how much each one spoke, first speaker first', () => {
  const segments = [
    voiced(0, 0, 10, 'SPEAKER_01'),
    voiced(1, 10, 40, 'SPEAKER_00'),
    voiced(2, 40, 45, 'SPEAKER_01'),
    seg(3, 45, 50, 'no speaker'),
  ]

  const summary = speakerSummary(segments)

  assert.deepEqual(summary.map((entry) => entry.name), ['SPEAKER_01', 'SPEAKER_00'])
  assert.equal(summary[0].utterances, 2)
  assert.equal(summary[0].seconds, 15)
  assert.equal(summary[1].seconds, 30)
})

test('the utterances of one speaker come back with where they are', () => {
  // What the second tab lists, and what makes each row clickable.
  const segments = [
    voiced(0, 0, 5, 'SPEAKER_00'),
    voiced(1, 5, 10, 'SPEAKER_01'),
    voiced(2, 10, 15, 'SPEAKER_00'),
  ]

  const found = utterancesOf(segments, 'SPEAKER_00')

  assert.deepEqual(found.map((entry) => entry.position), [0, 2], 'positions, so a click can scroll to them')
  assert.equal(found[1].segment.start, 10)
  assert.equal(utterancesOf(segments, 'SPEAKER_09').length, 0)
})
