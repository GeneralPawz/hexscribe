/**
 * Browser front-end tests.
 *
 * The page is plain ES modules with no build step, so there is no bundler to
 * catch a typo. These cover what can break without a browser: the routes that
 * serve it, the export endpoint it depends on, and the pure helpers its display
 * logic uses (imported directly -- they touch no DOM).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as servePlugin from '../src/serve/index.ts'
import * as uiPlugin from '../src/ui/index.ts'
import { clock, humanSize } from '../src/ui/public/js/dom.js'
import { damageNote } from '../src/ui/public/js/transcript.js'
import { activeIndex } from '../src/ui/public/js/player.js'
import { estimateSeconds, progressAt, readRtf, recordRtf } from '../src/ui/public/js/progress.js'
import {
  at as anchor,
  noteAt,
  rowOf,
  rowsWithTag,
  spanAt,
  spans,
  taggedRows,
  tagsAt,
  tagsInRun,
} from '../src/ui/public/js/annotations.js'

/**
 * Schemastery fills a plugin's remaining config at load time, but the caller's
 * type is `apply`'s parameter — the resolved shape. Tests supply only what they
 * vary, so this is the one place that gap is bridged.
 */
const withDefaults = <T,>(partial: Partial<T>): T => partial as T

const VERBOSE = {
  task: 'transcribe',
  language: 'de',
  duration: 3.25,
  text: 'erster Satz zweiter Satz',
  segments: [
    { id: 0, start: 0, end: 1.5, text: 'erster Satz' },
    { id: 1, start: 1.5, end: 3.25, text: 'zweiter Satz' },
  ],
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(asrPlugin, {})
  await ctx.plugin(servePlugin, withDefaults<servePlugin.ServeConfig>({ host: '127.0.0.1', port: 0 }))
  await ctx.plugin(uiPlugin, withDefaults<uiPlugin.Config>({}))
  const url = await ctx.serve.ready()
  // Route registration reads the asset directory, so let that settle.
  await new Promise((resolve) => setTimeout(resolve, 200))
  return { ctx, url, dispose: () => ctx.root.fiber.dispose() }
}

const postFormat = (url: string, to: string, body: unknown) =>
  fetch(`${url}/ui/format?to=${to}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('the root serves the page, not a JSON error', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const response = await fetch(`${app.url}/`)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  const html = await response.text()
  assert.match(html, /<title>hexscribe<\/title>/)
  assert.match(html, /\/ui\/js\/main\.js/)
})

test('assets are served with the content types a browser needs', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const expected: Array<[string, RegExp]> = [
    ['/ui/app.css', /text\/css/],
    ['/ui/js/main.js', /text\/javascript/],
    ['/ui/js/api.js', /text\/javascript/],
    ['/ui/js/dom.js', /text\/javascript/],
    ['/ui/js/transcript.js', /text\/javascript/],
    ['/ui/js/shader.js', /text\/javascript/],
    ['/ui/js/player.js', /text\/javascript/],
    ['/ui/js/progress.js', /text\/javascript/],
    ['/ui/js/segments.js', /text\/javascript/],
    ['/ui/js/menu.js', /text\/javascript/],
    ['/ui/js/aside.js', /text\/javascript/],
    ['/ui/js/panel-speaker.js', /text\/javascript/],
    ['/ui/js/panel-download.js', /text\/javascript/],
  ]
  for (const [path, contentType] of expected) {
    const response = await fetch(app.url + path)
    assert.equal(response.status, 200, `${path} should be served`)
    assert.match(response.headers.get('content-type') ?? '', contentType, path)
  }
})

test('the idle field is decoration: the page works without it', async (t) => {
  // shader.js is imported by main.js and mounts a WebGL canvas. Everything about
  // it is optional by construction -- no WebGL, a refused shader, a lost context
  // and it removes itself -- so the page must never depend on it for layout or
  // behaviour. What is pinned here is that it is served and that the drop zone
  // is complete without it.
  const app = await harness()
  t.after(app.dispose)

  const html = await (await fetch(`${app.url}/`)).text()
  assert.match(html, /id="drop"/)
  assert.doesNotMatch(html, /<canvas/, 'the canvas is created by script, never shipped in markup')

  const shader = await fetch(`${app.url}/ui/js/shader.js`)
  assert.equal(shader.status, 200)
  const source = await shader.text()
  assert.match(source, /export function mountShader/)
  assert.match(source, /prefers-reduced-motion/, 'must honour reduced motion')
})

test('hidden panels stay hidden, whatever display they set for themselves', async (t) => {
  // Regression: `.progress { display: flex }` beat the `hidden` attribute, so the
  // indeterminate bar animated while the app was idle -- claiming work that was
  // not happening. The [hidden] rule is what makes `show()` mean anything.
  const app = await harness()
  t.after(app.dispose)

  const css = await (await fetch(`${app.url}/ui/app.css`)).text()

  assert.match(css.replace(/\s+/g, ' '), /\[hidden\] \{ display: none !important; \}/)
})

test('only enumerated assets exist, so paths cannot be traversed', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  for (const path of ['/ui/nope.js', '/ui/../cordis.yml', '/ui/js/../../../package.json']) {
    assert.equal((await fetch(app.url + path)).status, 404, path)
  }
})

test('the export endpoint renders with the same code the CLI uses', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const srt = await postFormat(app.url, 'srt', VERBOSE)
  assert.equal(srt.status, 200)
  assert.equal(
    await srt.text(),
    '1\n00:00:00,000 --> 00:00:01,500\nerster Satz\n\n2\n00:00:01,500 --> 00:00:03,250\nzweiter Satz\n',
  )

  const vtt = await postFormat(app.url, 'vtt', VERBOSE)
  assert.match(await vtt.text(), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.500/)

  const text = await postFormat(app.url, 'text', VERBOSE)
  assert.equal(await text.text(), 'erster Satz\nzweiter Satz')
})

test('exports keep speaker labels', async (t) => {
  // The mapping back from verbose_json dropped `speaker` once, which produced
  // unlabelled .srt downloads from a diarized transcript with no error anywhere.
  const app = await harness()
  t.after(app.dispose)

  const diarized = {
    ...VERBOSE,
    speakers: ['SPEAKER_00', 'SPEAKER_01'],
    segments: [
      { ...VERBOSE.segments[0], speaker: 'SPEAKER_00' },
      { ...VERBOSE.segments[1], speaker: 'SPEAKER_01' },
    ],
  }

  assert.match((await (await postFormat(app.url, 'srt', diarized)).text()), /\[SPEAKER_00\] erster Satz/)
  assert.equal(
    await (await postFormat(app.url, 'text', diarized)).text(),
    'SPEAKER_00: erster Satz\nSPEAKER_01: zweiter Satz',
  )
})

test('the export endpoint refuses what it cannot render', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  assert.equal((await postFormat(app.url, 'docx', VERBOSE)).status, 400)
  assert.equal((await postFormat(app.url, 'srt', 'not json at all')).status, 400)

  const noSegments = await postFormat(app.url, 'srt', { text: 'hello' })
  assert.equal(noSegments.status, 400)
  assert.match(((await noSegments.json()) as any).error.message, /segments/)
})

test('unloading the ui plugin leaves the API intact', async (t) => {
  const ctx = new Context()
  await ctx.plugin(asrPlugin, {})
  await ctx.plugin(servePlugin, withDefaults<servePlugin.ServeConfig>({ host: '127.0.0.1', port: 0 }))
  const ui = await ctx.plugin(uiPlugin, withDefaults<uiPlugin.Config>({}))
  const url = await ctx.serve.ready()
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.after(() => ctx.root.fiber.dispose())

  assert.equal((await fetch(`${url}/`)).status, 200)

  await ui.dispose()

  assert.equal((await fetch(`${url}/`)).status, 404, 'the page should be gone')
  assert.equal((await fetch(`${url}/ui/app.css`)).status, 404, 'its assets too')
  assert.equal((await fetch(`${url}/health`)).status, 200, 'but the API is untouched')
})

test('playback maps a moment in the audio to the utterance being spoken', () => {
  // What a click on a timestamp, and every tick of playback, resolves through.
  const segments = [
    { start: 0, end: 5 },
    { start: 5, end: 12 },
    { start: 12, end: 20 },
  ]

  assert.equal(activeIndex(segments, 0), 0)
  assert.equal(activeIndex(segments, 4.9), 0)
  assert.equal(activeIndex(segments, 5), 1)
  assert.equal(activeIndex(segments, 19.5), 2)
  assert.equal(activeIndex(segments, 999), 2, 'past the end stays on the last utterance')
  assert.equal(activeIndex([], 3), -1)

  // Seeking to a segment's own start must land on *it*, not the one before:
  // the browser reports a currentTime a hair under what was asked for, so the
  // last fraction of a second before a boundary resolves forward.
  assert.equal(activeIndex(segments, 4.98), 1, 'within tolerance of the next start')
  assert.equal(activeIndex(segments, 11.98), 2, 'same rule at every boundary')
  assert.equal(activeIndex(segments, 4.9), 0, 'outside the tolerance it does not')
})

/** Float comparison: these are ratios of measured times, never exact. */
const close = (actual: number, expected: number, note = '') =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${note} expected ~${expected}, got ${actual}`)

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    read: (key: string) => store.get(key),
  }
}

test('progress is estimated from the audio, and never claims to be finished', () => {
  // The API answers once, at the end, so this is the only progress there is:
  // elapsed time against a prediction. It must approach the end and stop.
  assert.equal(progressAt(0, 10), 0)
  assert.ok(progressAt(5, 10) > 0.4 && progressAt(5, 10) < 0.7)
  assert.ok(progressAt(10, 10) > 0.7)
  assert.ok(progressAt(600, 10) <= 0.95, 'a wildly long run tops out short of the end')
  assert.ok(progressAt(1e6, 10) < 1, 'and never reaches it')
  assert.equal(progressAt(5, 0), 0, 'no estimate, no progress')
})

test('the estimate scales with the audio and with what diarization costs', () => {
  close(estimateSeconds(100, { rtf: 0.09 }), 9)
  close(estimateSeconds(100, { rtf: 0.09, diarize: true }), 12.15, 'speakers cost a third again')
  close(estimateSeconds(1, { rtf: 0.09 }), 1.5, 'a floor, so a short clip is not "instant"')
  close(estimateSeconds(0, { rtf: 0.09 }), 2.7, 'unknown duration falls back to an assumption')
})

test('each run teaches the next one how fast this machine is', () => {
  const storage = fakeStorage()
  close(readRtf(storage as never), 0.09, 'a default until it has seen a run')

  recordRtf(100, 5, storage as never) // measured 0.05, blended with the 0.09 default
  close(readRtf(storage as never), 0.07)

  recordRtf(100, 5, storage as never)
  close(readRtf(storage as never), 0.06, 'converges toward what this machine actually does')

  const before = readRtf(storage as never)
  recordRtf(0, 5, storage as never)
  close(readRtf(storage as never), before, 'a nonsense run is ignored, not averaged in')
})

test('a transcript missing audio says so, and a complete one says nothing', () => {
  // The failure this exists for: an hour-long MP3 with one bad packet in 196,800.
  // Skipping it is right; letting the result look complete is not, because
  // nothing downstream can tell an incomplete transcript by looking at it.
  assert.equal(damageNote({ segments: [] }), '', 'silence when nothing was skipped')
  assert.equal(damageNote({ segments: [], damage: { skipped_packets: 0, total_packets: 100 } }), '')

  const one = damageNote({ segments: [], damage: { skipped_packets: 1, total_packets: 196800 } })
  assert.match(one, /1 damaged audio packet was skipped/)
  assert.match(one, /0\.00%/, 'and how much of the file that was')
  assert.match(one, /missing/)

  const many = damageNote({ segments: [], damage: { skipped_packets: 12, total_packets: 1000 } })
  assert.match(many, /12 damaged audio packets were skipped/, 'plural reads correctly')
  assert.match(many, /1\.20%/)
})

test('the API reports skipped audio alongside the transcript', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  // `/ui/format` is the round trip a download takes; the field must survive it
  // rather than being dropped on the way to a subtitle file.
  const damaged = { ...VERBOSE, damage: { skipped_packets: 3, total_packets: 500 } }
  const srt = await postFormat(app.url, 'srt', damaged)
  assert.equal(srt.status, 200, 'a blemished transcript still renders')
})

test('the page formats clock times and sizes the way a reader expects', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(93.4), '1:33')
  assert.equal(clock(3812), '1:03:32')
  assert.equal(clock(-5), '0:00')

  assert.equal(humanSize(512), '512 B')
  assert.equal(humanSize(2048), '2.0 kB')
  assert.equal(humanSize(15 * 1024 * 1024), '15 MB')
})

// --- sections, comments and tags --------------------------------------
//
// Everything here is anchored to *when* a line was said rather than to which
// row it is, because merging two utterances renumbers every one after them. An
// annotation that slid onto a neighbouring sentence would still look right,
// which is what makes it worth pinning.

const LINES = [
  { start: 0, end: 10, text: 'a', speaker: 'S0' },
  { start: 10, end: 20, text: 'b', speaker: 'S1' },
  { start: 20.005, end: 30, text: 'c', speaker: 'S0' },
]

test('a section runs until the next one starts', () => {
  const sections = [
    { start: 600, title: 'The actual question' },
    { start: 0, title: 'Introductions' },
  ]
  assert.deepEqual(spans(sections, 1800), [
    { start: 0, end: 600, title: 'Introductions' },
    { start: 600, end: 1800, title: 'The actual question' },
  ], 'sorted, and covering the recording without gaps or overlaps')

  // Nothing before the first section belongs to one: marking up the middle of a
  // recording must not silently claim the beginning of it.
  const late = [{ start: 300, title: 'Late' }]
  assert.equal(spanAt(late, 900, 100), undefined)
  assert.equal(spanAt(late, 900, 300)?.title, 'Late', 'the first instant is inside')
  assert.equal(spanAt(late, 900, 899)?.title, 'Late')

  // A section past the end of a duration nobody measured still has a length.
  assert.deepEqual(spans([{ start: 50, title: 'x' }], 0), [{ start: 50, end: 50, title: 'x' }])
})

test('an annotation finds its line by time, at millisecond precision', () => {
  assert.equal(anchor(20.0049), 20.005)
  assert.equal(rowOf(LINES, 20.005), 2, 'the anchor the store wrote')
  assert.equal(rowOf(LINES, 20.00499), 2, 'and the same instant read back a hair differently')
  assert.equal(rowOf(LINES, 21), -1, 'but not the middle of a line, which is a different thing')
})

test('comments and tags belong to a line, not to a position', () => {
  const notes = [{ start: 10, body: 'she hesitated' }]
  const tags = [
    { start: 10, tag: 'pricing' },
    { start: 10, tag: 'follow up' },
    { start: 0, tag: 'pricing' },
  ]

  assert.equal(noteAt(notes, 10), 'she hesitated')
  assert.equal(noteAt(notes, 0), '', 'and a line without one has none, not undefined')
  assert.deepEqual(tagsAt(tags, 10), ['follow up', 'pricing'], 'alphabetical, so the chips do not shuffle')
  assert.deepEqual(tagsAt(tags, 20.005), [])

  // The merge case: `b` absorbs `c`, so the third line is gone and the second
  // now runs 10--30. The comment is still on the line that starts at 10.
  const merged = [LINES[0], { start: 10, end: 30, text: 'b c', speaker: 'S1' }]
  assert.equal(noteAt(notes, merged[1].start), 'she hesitated')
  assert.equal(rowOf(merged, 10), 1)
})

test('a tag knows which lines carry it, and this run knows which tags it uses', () => {
  const tags = [
    { start: 0, tag: 'pricing' },
    { start: 20.005, tag: 'pricing' },
    { start: 10, tag: 'off topic' },
  ]
  assert.deepEqual(rowsWithTag(LINES, tags, 'pricing'), [0, 2])
  assert.deepEqual(rowsWithTag(LINES, tags, 'nothing'), [])
  assert.deepEqual(tagsInRun(tags), [
    { name: 'pricing', uses: 2 },
    { name: 'off topic', uses: 1 },
  ], 'most used first: what this recording is actually about')
})

test('the transcript marks which lines have been written on', () => {
  const marks = taggedRows(LINES, {
    sections: [],
    notes: [{ start: 0, body: 'x' }],
    tags: [{ start: 20.005, tag: 'pricing' }],
  })
  assert.deepEqual([...marks.keys()], [0, 2])
  assert.deepEqual(marks.get(0), { tagged: false, noted: true })
  assert.deepEqual(marks.get(2), { tagged: true, noted: false })
})
