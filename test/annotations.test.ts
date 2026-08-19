/**
 * What somebody adds to a recording after the machine is done with it.
 *
 * Sections, comments and tags are the only things in the database a person
 * typed rather than a model produced, which makes them the expensive ones: a
 * transcript can be made again in four minutes of NPU, and an hour of reading
 * and marking up cannot be made again at all.
 *
 * So what is pinned here is mostly that they survive: an edit to the transcript
 * they hang off, a tag renamed underneath them, and the run being deleted —
 * where surviving would be the bug.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as storePlugin from '../src/store.ts'
import { at } from '../src/store.ts'
import type { Run } from '../src/store.ts'

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'hexscribe-annotations-'))
  const ctx = new Context()
  await ctx.plugin(storePlugin, { path: join(directory, 'test.db') })
  return {
    ctx,
    dispose: async () => {
      await ctx.root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const run = (id: string): Omit<Run, 'has_audio' | 'audio_bytes'> => ({
  id,
  name: `${id}.wav`,
  source: 'upload',
  path: null,
  source_path: null,
  status: 'done',
  created: 1,
  finished: 2,
  wall_ms: 1,
  engine: 'whisper',
  model: 'whisper-1',
  language: 'en',
  task: 'transcribe',
  diarize: 0,
  merge: 0,
  audio_seconds: 120,
  segments: 3,
  speakers: 0,
  rtf: 0,
  error: null,
})

const transcript = () => ({
  engine: 'whisper',
  model: 'whisper-1',
  language: 'en',
  segments: [
    { index: 0, start: 0, end: 10, text: 'a' },
    { index: 1, start: 10, end: 20, text: 'b' },
  ],
  text: 'a b',
  timing: { audio_seconds: 120, total_ms: 1, rtf: 0 },
})

test('the anchor is a time, rounded the same way on both sides', () => {
  // Notes are found again by matching an utterance's start against the one they
  // were written on. Whisper reports hundredths, but splitting an utterance
  // recomputes the boundary from a character offset and lands anywhere, so both
  // sides go through the same rounding rather than trusting float equality.
  assert.equal(at(12.3456789), 12.346)
  assert.equal(at(0.1 + 0.2), 0.3, 'and the classic float is not a different utterance')
})

test('a section names a stretch, and renaming it is saving it again', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  assert.equal(app.ctx.store.saveSection('a', 0, 'Introductions'), true)
  assert.equal(app.ctx.store.saveSection('a', 600, 'The actual question'), true)
  assert.equal(app.ctx.store.saveSection('a', 0, 'Small talk'), true, 'the same start is the same section')

  const { sections } = app.ctx.store.annotations('a')
  assert.deepEqual(sections, [
    { start: 0, title: 'Small talk' },
    { start: 600, title: 'The actual question' },
  ], 'in the order they are heard, not the order they were made')

  assert.equal(app.ctx.store.saveSection('a', 60, '   '), false, 'a section without a name is not one')
  assert.equal(app.ctx.store.saveSection('nobody', 0, 'Anything'), false, 'nor is one on a run that is gone')

  assert.equal(app.ctx.store.deleteSection('a', 600), true)
  assert.equal(app.ctx.store.deleteSection('a', 600), false, 'and it says so when there was nothing')
  assert.equal(app.ctx.store.annotations('a').sections.length, 1)
})

test('a comment is kept against the utterance, and clearing it deletes it', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.saveNote('a', 10, 'ask about this again')
  assert.equal(app.ctx.store.annotations('a').notes[0].body, 'ask about this again')

  app.ctx.store.saveNote('a', 10, 'ask about this again — she hesitated')
  const notes = app.ctx.store.annotations('a').notes
  assert.equal(notes.length, 1, 'one comment per utterance, not a thread')
  assert.match(notes[0].body, /hesitated/)

  // Emptying the box is how a comment is removed. Anything else would be a
  // delete button nobody looks for, and a row holding an empty string.
  app.ctx.store.saveNote('a', 10, '   ')
  assert.deepEqual(app.ctx.store.annotations('a').notes, [])
})

test('a tag is added to the vocabulary by being used', async (t) => {
  // There is no "create a tag" step on purpose: a form to fill in before you
  // can say anything is a good way to be sure nothing gets said.
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveRun(run('b'), transcript())

  app.ctx.store.tagUtterance('a', 0, 'pricing')
  app.ctx.store.tagUtterance('a', 10, 'pricing')
  app.ctx.store.tagUtterance('a', 10, 'pricing', true) // twice is once
  app.ctx.store.tagUtterance('b', 0, 'pricing')
  app.ctx.store.tagUtterance('a', 0, 'off topic')

  const library = app.ctx.store.listTags()
  assert.deepEqual(library, [
    { name: 'pricing', uses: 3, runs: 2 },
    { name: 'off topic', uses: 1, runs: 1 },
  ], 'most used first, with the evidence for that order')

  assert.deepEqual(
    app.ctx.store.annotations('a').tags,
    [
      { start: 0, tag: 'off topic' },
      { start: 0, tag: 'pricing' },
      { start: 10, tag: 'pricing' },
    ],
  )

  assert.deepEqual(app.ctx.store.taggedWith('pricing'), [
    { run_id: 'a', start: 0 },
    { run_id: 'a', start: 10 },
    { run_id: 'b', start: 0 },
  ], 'and one tag reaches across runs, which is the whole point of a shared vocabulary')

  app.ctx.store.tagUtterance('a', 10, 'pricing', false)
  assert.equal(app.ctx.store.annotations('a').tags.length, 2)
  assert.equal(app.ctx.store.listTags()[0].uses, 2, 'the library follows')
})

test('renaming a tag carries every utterance with it, and merging is a rename', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.tagUtterance('a', 0, 'price')
  app.ctx.store.tagUtterance('a', 10, 'price')
  assert.equal(app.ctx.store.renameTag('price', 'pricing'), true)
  assert.deepEqual(
    app.ctx.store.annotations('a').tags.map((entry) => entry.tag),
    ['pricing', 'pricing'],
    'the attachments came along',
  )

  // Renaming onto a name that already exists is how two near-duplicates become
  // one. Failing here would leave somebody with `pricing` and `Pricing` and no
  // way to join them.
  app.ctx.store.tagUtterance('a', 0, 'Pricing')
  assert.equal(app.ctx.store.renameTag('Pricing', 'pricing'), true)
  assert.deepEqual(app.ctx.store.listTags(), [{ name: 'pricing', uses: 2, runs: 1 }])
})

test('deleting a run takes its sections, comments and tags with it', async (t) => {
  // Not the vocabulary, though: the words are worth keeping for the next
  // recording, and they are what makes tagging the second one useful.
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveRun(run('b'), transcript())

  app.ctx.store.saveSection('a', 0, 'Introductions')
  app.ctx.store.saveNote('a', 10, 'come back to this')
  app.ctx.store.tagUtterance('a', 10, 'pricing')
  app.ctx.store.tagUtterance('b', 0, 'pricing')

  app.ctx.store.deleteRun('a')

  const left = app.ctx.store.annotations('a')
  assert.deepEqual(left, { sections: [], notes: [], tags: [] })
  assert.deepEqual(app.ctx.store.listTags(), [{ name: 'pricing', uses: 1, runs: 1 }],
    'the word survives its recording')
})

test('the danger zone takes the vocabulary too', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveSection('a', 0, 'Introductions')
  app.ctx.store.saveNote('a', 0, 'a comment')
  app.ctx.store.tagUtterance('a', 0, 'pricing')

  assert.equal(app.ctx.store.stats().annotations, 3, 'counted, so Settings can say what is there')
  assert.equal(app.ctx.store.stats().tags, 1)

  app.ctx.store.reset()

  assert.equal(app.ctx.store.stats().annotations, 0)
  assert.equal(app.ctx.store.stats().tags, 0, 'delete everything means the words as well')
  assert.deepEqual(app.ctx.store.listTags(), [])
})

test('annotations reach the page with the run', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveSection('a', 0, 'Introductions')

  // `getRun` is what the HTTP route hands the browser; the route adds the
  // annotations beside the transcript so the page can render both at once.
  assert.equal(app.ctx.store.getRun('a')?.name, 'a.wav')
  assert.equal(app.ctx.store.annotations('a').sections[0].title, 'Introductions')
})

// --- when the line underneath moves ------------------------------------

test('joining two utterances carries the annotations of both', async (t) => {
  // The failure this exists for: comment on a sentence, then merge it into the
  // one above, and the comment is anchored to a moment no row begins at any
  // more. Not lost -- invisible, which is worse, because nobody goes looking.
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.saveNote('a', 0, 'the question')
  app.ctx.store.saveNote('a', 10, 'she hesitated')
  app.ctx.store.tagUtterance('a', 0, 'pricing')
  app.ctx.store.tagUtterance('a', 10, 'pricing')
  app.ctx.store.tagUtterance('a', 10, 'follow up')

  // Row 1 is merged into row 0, so 10 stops being the start of anything.
  assert.equal(app.ctx.store.moveAnnotations('a', 10, 0), true)

  const { notes, tags } = app.ctx.store.annotations('a')
  assert.equal(notes.length, 1, 'one line, one comment')
  assert.equal(
    notes[0].body,
    'the question\n\nshe hesitated',
    'and both halves of it: a merge is not somebody choosing which of their own notes to lose',
  )
  assert.deepEqual(
    tags.map((entry) => entry.tag),
    ['follow up', 'pricing'],
    'tags move, and one applied twice is applied once',
  )
  assert.ok(tags.every((entry) => entry.start === 0), 'all on the surviving line')
})

test('a heading that would land on a line that has one stays a single heading', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.saveSection('a', 0, 'Introductions')
  app.ctx.store.saveSection('a', 10, 'Small talk')
  app.ctx.store.moveAnnotations('a', 10, 0)

  assert.deepEqual(app.ctx.store.annotations('a').sections, [{ start: 0, title: 'Introductions' }],
    'the one the reader can already see wins; two headings on one line is not a thing')
})

test('moving an annotation nowhere is not a move', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())
  app.ctx.store.saveNote('a', 10, 'unchanged')

  assert.equal(app.ctx.store.moveAnnotations('a', 10, 10), false)
  assert.equal(app.ctx.store.annotations('a').notes[0].body, 'unchanged')
})

// --- nested tags --------------------------------------------------------

test('a branch answers for everything filed under it', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.tagUtterance('a', 0, 'pricing')
  app.ctx.store.tagUtterance('a', 10, ' pricing / discounts ')

  assert.deepEqual(
    app.ctx.store.annotations('a').tags.map((entry) => entry.tag),
    ['pricing', 'pricing/discounts'],
    'tidied on the way in: a trailing space is a typo, not a different tag',
  )
  assert.equal(app.ctx.store.taggedWith('pricing').length, 2, 'the branch finds its sublevel')
  assert.equal(app.ctx.store.taggedWith('pricing/discounts').length, 1, 'the leaf is only itself')
  assert.equal(app.ctx.store.taggedWith('pric').length, 0, 'and half a word is not a branch')
})

test('renaming a branch takes its sublevels with it', async (t) => {
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.tagUtterance('a', 0, 'price')
  app.ctx.store.tagUtterance('a', 10, 'price/discounts')
  assert.equal(app.ctx.store.renameTag('price', 'pricing'), true)

  assert.deepEqual(
    app.ctx.store.listTags().map((entry) => entry.name).sort(),
    ['pricing', 'pricing/discounts'],
    'one idea moved, not half of one',
  )
  assert.equal(app.ctx.store.taggedWith('pricing').length, 2)
})

test('forgetting a branch forgets what was under it', async (t) => {
  // Leaving the sublevels behind would leave a branch nobody can reach from the
  // list, which is a worse kind of gone than gone.
  const app = await store()
  t.after(app.dispose)
  app.ctx.store.saveRun(run('a'), transcript())

  app.ctx.store.tagUtterance('a', 0, 'pricing')
  app.ctx.store.tagUtterance('a', 10, 'pricing/discounts')
  app.ctx.store.tagUtterance('a', 10, 'staffing')

  assert.equal(app.ctx.store.deleteTag('pricing'), true)
  assert.deepEqual(app.ctx.store.listTags().map((entry) => entry.name), ['staffing'])
  assert.deepEqual(
    app.ctx.store.annotations('a').tags.map((entry) => entry.tag),
    ['staffing'],
    'and the attachments went with them',
  )
})
