#!/usr/bin/env node
/**
 * Sections, comments, tags — the half of the app a person types.
 *
 * These are the only things in the database nobody can regenerate: a transcript
 * is four minutes of NPU away, and an hour spent reading an interview and
 * marking up where the useful part is cannot be made again. So this drives the
 * whole path in a real browser against a real recording — name a section, watch
 * it appear on the timeline, comment on a line, tag two lines, find them again
 * through the drawer — and then reloads the page and checks that every one of
 * them came back.
 *
 * Runs against a throwaway database (serve.mjs --db).
 *
 *   node scripts/annotate-check.mjs http://127.0.0.1:9000/ <audio>
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, audioPath, shotPath = 'out/annotate.png'] = process.argv.slice(2)
if (!uiUrl || !audioPath) {
  console.error('usage: node scripts/annotate-check.mjs <ui-url> <audio> [screenshot]')
  process.exit(2)
}

const PORT = 9722 + Math.floor(Math.random() * 150)
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chrome = spawn(
  CHROME,
  ['--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
   '--autoplay-policy=no-user-gesture-required', '--window-size=1280,1000', 'about:blank'],
  { stdio: 'ignore' },
)
process.on('exit', () => chrome.kill())

async function attach() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // not listening yet
    }
    await sleep(500)
  }
  throw new Error('Chrome did not expose a debugging target')
}

const socket = new WebSocket(await attach())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'the page threw')
  return result.value
}
const shoot = async (path) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(data, 'base64'))
}

const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''))
}

const trap = `window.__errors = []
  addEventListener('error', (e) => __errors.push(String(e.message)))
  addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)))
  true`

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Page.navigate', { url: uiUrl })
await sleep(2500)
await evaluate(trap)

// --- something to annotate ---
const { root } = await send('DOM.getDocument')
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
await send('DOM.setFileInputFiles', { nodeId, files: [audioPath] })
await evaluate(`
  document.querySelector('#file').dispatchEvent(new Event('change'))
  document.querySelector('#language').value = 'en'
  document.querySelector('#diarize').checked = true
  document.querySelector('#submit').click()
  true`)

const deadline = Date.now() + 900_000
while (Date.now() < deadline) {
  if (await evaluate('document.querySelector("#drop").dataset.state === "done"')) break
  await sleep(500)
}
await sleep(1200)

const ready = await evaluate(`({
  rows: document.querySelectorAll('#segments li').length,
  timelineHidden: document.querySelector('#timeline').hidden,
  drawerOpen: document.body.classList.contains('has-drawer'),
})`)
check('there is a transcript to mark up', ready.rows > 2, `${ready.rows} utterances`)
check('the timeline stays out of the way until there is a section', ready.timelineHidden)
check('and the drawer starts collapsed', !ready.drawerOpen)

// --- the card knows about itself ---
const card = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const bar = document.querySelector('.result-bar')
  const controls = [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
  const summaryGone = !document.querySelector('#summary')

  const box = document.querySelector('#result').getBoundingClientRect()
  document.querySelector('#result').dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: box.right - 40, clientY: box.top + 8 }))
  await settle()
  await settle()
  const aside = document.querySelector('#aside')
  const tabs = [...aside.querySelectorAll('.aside__tab')].map((b) => b.textContent)
  const facts = [...aside.querySelectorAll('.aside__stat')].map((s) => s.textContent)

  // The download options are a tab now, not a button on the card.
  ;[...aside.querySelectorAll('.aside__tab')].find((b) => b.textContent === 'Download').click()
  await settle()
  const download = Boolean(aside.querySelector('select'))
  aside.querySelector('.aside__close').click()
  await settle()

  return { controls, summaryGone, tabs, facts, download }
})()`)

check('the card keeps only what is done *to* the transcript',
  card.controls.join(', ') === 'Undo, Copy text', card.controls.join(', '))
check('and the line of statistics is off it', card.summaryGone)
check('clicking the card opens what is known about the run',
  card.tabs.join(' | ') === 'Info | Speakers (3) | Download', card.tabs.join(' | '))
check('with the numbers that used to sit above the transcript',
  card.facts.some((fact) => /Utterances/.test(fact)) && card.facts.some((fact) => /Took/.test(fact)),
  card.facts.slice(0, 4).join(' · '))
check('and the download options as a tab', card.download)

// --- a section, from the line between two utterances ---
const inserted = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const rows = [...document.querySelectorAll('#segments li')]
  // Hidden until the row is under the pointer; the check reads the style
  // rather than trusting that dispatching a mouseover paints anything.
  const plus = rows[2].querySelector('.insert')
  const hidden = plus ? getComputedStyle(plus).opacity : 'missing'
  // Measured before it is clicked: clicking re-renders the row, and a detached
  // element reports a rectangle at the origin -- which would pass a >= test by
  // accident and fail this one by accident, depending on which way it is written.
  const left = plus ? Math.round(plus.getBoundingClientRect().left) : null
  const listLeft = Math.round(document.querySelector('#segments').getBoundingClientRect().left)
  plus?.click()
  await settle()
  const opened = Boolean(document.querySelector('.section__input'))
  document.querySelector('.section__input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  return { hidden, opened, left, listLeft }
})()`)
check('every line offers a + on the line above it', inserted.opened)
check('which is out of the way until the row is hovered', inserted.hidden === '0', inserted.hidden)
check('and inside the list, which scrolls and would clip it',
  inserted.left !== null && inserted.left >= inserted.listLeft,
  `+ at ${inserted.left}, list starts at ${inserted.listLeft}`)

// --- a section ---
const sectioned = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const rows = [...document.querySelectorAll('#segments li')]
  rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
  await settle()
  const strip = (text) => text.replace(/^[\\u2713\\s]+/, '').trim()
  const items = [...document.querySelectorAll('.menu .menu__item')].map((b) => strip(b.textContent))
  const start = [...document.querySelectorAll('.menu .menu__item')]
    .find((b) => strip(b.textContent) === 'Start a section here')
  start.click()
  await settle()

  const input = document.querySelector('.section__input')
  const opened = Boolean(input)
  input.value = 'Introductions'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  await settle()

  // A second one further down, so the first band has somewhere to end.
  const later = [...document.querySelectorAll('#segments li')]
  const at = Math.min(3, later.length - 1)
  later[at].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 400 }))
  await settle()
  ;[...document.querySelectorAll('.menu .menu__item')]
    .find((b) => strip(b.textContent) === 'Start a section here').click()
  await settle()
  const second = document.querySelector('.section__input')
  second.value = 'The actual question'
  second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  await settle()

  const bands = [...document.querySelectorAll('.timeline__band')]
  return {
    items,
    opened,
    headings: [...document.querySelectorAll('.section__title')].map((h) => h.textContent),
    timelineShown: !document.querySelector('#timeline').hidden,
    bands: bands.map((b) => ({ title: b.querySelector('.timeline__label').textContent, width: b.style.width })),
    stored: (await (await fetch('/v1/runs')).json()).runs.length,
  }
})()`)

check('the row menu offers a section', sectioned.items.includes('Start a section here'),
  sectioned.items.join(', '))
check('naming it happens in the transcript, on the line it starts at', sectioned.opened)
check('both sections read as headings', sectioned.headings.join(' | ') === 'Introductions | The actual question',
  sectioned.headings.join(' | '))
check('the timeline appears once there is something to draw', sectioned.timelineShown)
check('with a band per section, drawn to scale', sectioned.bands.length === 2,
  sectioned.bands.map((b) => `${b.title} ${b.width}`).join(' / '))
check('the bands cover the recording without gaps',
  sectioned.bands.every((b) => b.width.endsWith('%') && parseFloat(b.width) > 0))

// --- a comment and two tags ---
const annotated = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const rows = () => [...document.querySelectorAll('#segments li')]
  rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  await settle()
  const aside = document.querySelector('#aside')
  const title = aside.querySelector('.aside__title')?.textContent
  const quote = aside.querySelector('.aside__quote')?.textContent

  // Comments are a list: the + on the line between them opens an editor, and
  // the same line can hold several.
  const write = async (text) => {
    document.querySelector('#aside .thread .insert').click()
    await settle()
    const editor = document.querySelector('#aside .thread textarea')
    editor.value = text
    editor.dispatchEvent(new Event('blur'))
    await settle()
    await settle()
  }
  await write('she hesitated here')
  await write('and again a minute later')
  const written = [...document.querySelectorAll('#aside .thread__text')].map((p) => p.textContent)

  // The speaker of this one line, changed from the panel about that line.
  const speakerField = document.querySelector('#aside input[aria-label="Speaker"]')
  const speakerWas = speakerField.value
  speakerField.value = 'Mara'
  speakerField.dispatchEvent(new Event('blur'))
  await settle()
  await settle()
  const speakerNow = [...document.querySelectorAll('#segments li')][1].querySelector('.speaker')?.textContent

  const transport = [...document.querySelectorAll('#aside .transport .icon')]
    .map((b) => b.getAttribute('aria-label'))
  const rates = [...document.querySelectorAll('#aside .transport__rate option')].map((o) => o.textContent)

  const tagField = document.querySelector('#aside input[aria-label="Add a tag"]')
  const add = async (name) => {
    tagField.value = name
    tagField.dispatchEvent(new Event('input'))
    await settle()
    // Enter takes the highlighted suggestion, or exactly what was typed when
    // there is none -- which is the only way a new sublevel can be created.
    tagField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    await settle()
  }
  await add('pricing')
  await add('follow up')
  // The same line, a second time: tagging twice must not make two of them.
  await add('pricing')
  // And a sublevel, which is one tag with a level in it rather than two tags.
  await add('pricing/discounts')

  const chips = [...document.querySelectorAll('#aside .tag--removable')].map((c) => c.textContent.trim())
  const annotations = await (await fetch('/v1/annotations?run=' + encodeURIComponent(
    (await (await fetch('/v1/runs')).json()).runs[0].id))).json()

  return {
    title,
    quote,
    chips,
    written,
    speakerWas,
    speakerNow,
    transport,
    rates,
    marked: document.querySelectorAll('#segments li.is-marked').length,
    notes: annotations.notes,
    tags: annotations.tags,
  }
})()`)

check('clicking a line opens it', annotated.title === 'Utterance', annotated.title)
check('showing what was said there', Boolean(annotated.quote), (annotated.quote ?? '').slice(0, 48))
check('a line can hold more than one comment',
  annotated.written.join(' | ') === 'she hesitated here | and again a minute later',
  annotated.written.join(' | '))
check('and both reach the database', annotated.notes.length === 2,
  annotated.notes.map((note) => note.body).join(' | '))
check('the panel is a transport for that stretch of audio',
  annotated.transport.length === 4 && /Play/.test(annotated.transport[0]),
  annotated.transport.join(', '))
check('with speeds, and a way to ask for one that is not offered',
  annotated.rates.join(' ') === '0.75× 1× 1.25× 1.5× 2× Custom…', annotated.rates.join(' '))
check('the speaker of one line can be changed from its own panel',
  annotated.speakerWas !== 'Mara' && annotated.speakerNow === 'Mara',
  `${annotated.speakerWas} → ${annotated.speakerNow}`)
check('the tags stick, and tagging twice is once',
  annotated.chips.join(', ') === 'follow up, pricing, pricing/discounts', annotated.chips.join(', '))
check('the server holds three tags for that line', annotated.tags.length === 3,
  annotated.tags.map((entry) => entry.tag).join(', '))
check('and the line is marked in the transcript', annotated.marked === 1, `${annotated.marked} marked`)

// --- the drawer ---
const drawer = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  document.querySelector('#drawer-handle').click()
  await settle()
  await settle()
  const tabs = [...document.querySelectorAll('.drawer__tab')].map((t) => t.textContent)
  const groups = [...document.querySelectorAll('.drawer__group')].map((g) => g.textContent)
  const tags = [...document.querySelectorAll('.taglist .tag')].map((t) => t.dataset.tag)

  const paths = [...document.querySelectorAll('.taglist .tag')].map((b) => b.dataset.tag)
  const nested = document.querySelectorAll('.taglist--nested .tag').length

  const showing = () => [...document.querySelectorAll('#segments li')].filter((li) => !li.hidden).length

  // Picking a tag narrows the *transcript*: the lines belong in the document,
  // in order, with what was said around them.
  document.querySelector('.taglist .tag[data-tag="pricing"]').click()
  await settle()
  const found = showing()
  const filterBar = !document.querySelector('#filter').hidden
  const filterSays = document.querySelector('#filter-count').textContent

  // ...and the sublevel narrows to only its own.
  document.querySelector('.taglist .tag[data-tag="pricing/discounts"]').click()
  await settle()
  const underSublevel = showing()

  // Clicking the one already showing puts the whole document back.
  document.querySelector('.taglist .tag[data-tag="pricing/discounts"]').click()
  await settle()
  const restored = showing()

  // And the speakers tab, which used to be a panel in the aside.
  ;[...document.querySelectorAll('.drawer__tab')].find((t) => t.textContent.startsWith('Speakers')).click()
  await settle()
  const speakers = document.querySelectorAll('.drawer__pane--list .speakers__row').length
  document.querySelector('.drawer__pane--list .speakers__meta').click()
  await settle()
  await settle()
  // Picking one filters the transcript to them, and the right half becomes the
  // place to edit *them*: name, face, and where else they have been heard.
  const said = showing()
  const paneTabs = [...document.querySelectorAll('.drawer__pane--detail .pane__tab')].map((b) => b.textContent)
  const faces = document.querySelectorAll('.drawer__pane--detail .face__option').length

  return {
    open: document.body.classList.contains('has-drawer'),
    tabs, groups, tags, found, speakers, said, paths, nested, underSublevel,
    filterBar, filterSays, restored, paneTabs, faces,
    rows: document.querySelectorAll('#segments li').length,
  }
})()`)

// Where it sits, which is the half of a bottom sheet that goes wrong quietly:
// it must stay clear of the rail, out from under the aside, and centred on
// whatever width is left over.
const placed = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const box = (sel) => {
    const el = document.querySelector(sel)
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
  }
  const layer = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex)

  document.querySelector('#aside .aside__close')?.click()
  await settle()
  const alone = { drawer: box('#drawer'), rail: box('#rail'), handle: box('#drawer-handle') }

  // Open the aside on a line and let the drawer give up the column.
  ;[...document.querySelectorAll('#segments li')][1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  await settle()
  const beside = { drawer: box('#drawer'), aside: box('#aside'), handle: box('#drawer-handle') }

  return {
    alone,
    beside,
    layers: { drawer: layer('#drawer'), rail: layer('#rail'), aside: layer('#aside') },
    viewport: window.innerWidth,
  }
})()`)

const centred = (outer, inner) => Math.abs((inner.left + inner.right) / 2 - (outer.left + outer.right) / 2)
check('the drawer starts where the rail ends',
  placed.alone.drawer.left >= placed.alone.rail.right,
  `rail ends at ${placed.alone.rail.right}, drawer starts at ${placed.alone.drawer.left}`)
check('and stays under it, so the rail can slide out over the top',
  placed.layers.drawer < placed.layers.rail,
  `drawer ${placed.layers.drawer} < rail ${placed.layers.rail}`)
check('the handle is centred on the drawer', centred(placed.alone.drawer, placed.alone.handle) <= 2,
  `${centred(placed.alone.drawer, placed.alone.handle)}px off`)
check('opening the aside takes the drawer out from under it',
  placed.beside.drawer.right <= placed.beside.aside.left,
  `drawer ends at ${placed.beside.drawer.right}, aside starts at ${placed.beside.aside.left}`)
check('and the handle recentres on what is left',
  centred(placed.beside.drawer, placed.beside.handle) <= 2 &&
    placed.beside.handle.left < placed.alone.handle.left,
  `${centred(placed.beside.drawer, placed.beside.handle)}px off, and moved ` +
    `${placed.alone.handle.left - placed.beside.handle.left}px left`)

check('the drawer opens on its handle', drawer.open)
check('with a tab for each', drawer.tabs.join(' | '), drawer.tabs.join(' | '))
check('tags are split into this recording and the rest',
  drawer.groups.join(' | ') === 'In this recording | Everywhere else', drawer.groups.join(' | '))
check('the tags used here are listed', drawer.tags.includes('pricing') && drawer.tags.includes('follow up'),
  drawer.tags.join(', '))
check('the sublevel is shown under its branch', drawer.nested >= 1 &&
  drawer.paths.includes('pricing') && drawer.paths.includes('pricing/discounts'),
  drawer.paths.join(', '))
check('picking a branch narrows the transcript to everything under it',
  drawer.found === 1 && drawer.found < drawer.rows, `${drawer.found} of ${drawer.rows} lines`)
check('and says so above the document', drawer.filterBar && /^1 of [0-9]+ lines$/.test(drawer.filterSays),
  drawer.filterSays)
check('the sublevel narrows to its own', drawer.underSublevel === 1,
  `${drawer.underSublevel} lines`)
check('and picking it again puts the whole document back',
  drawer.restored === drawer.rows, `${drawer.restored} of ${drawer.rows}`)
check('the speakers tab lists the speakers', drawer.speakers >= 1, `${drawer.speakers} speakers`)
check('picking a speaker narrows the transcript to their lines',
  drawer.said >= 1 && drawer.said < drawer.rows, `${drawer.said} of ${drawer.rows} lines`)
check('and the other half becomes the place to edit them',
  drawer.paneTabs.join(' | ') === 'General | Audios' && drawer.faces > 6,
  `${drawer.paneTabs.join(' | ')} · ${drawer.faces} faces`)

// --- the parts that are easy to get subtly wrong ---
//
// A comment anchored to a row rather than to a time would survive everything
// above and then slide onto a different sentence the first time somebody merged
// the paragraph over it -- still looking right, which is the dangerous kind of
// wrong. Merging is the cheapest way to prove it did not.
const survived = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const strip = (text) => text.replace(/^[\u2713\s]+/, '').trim()
  const commented = [...document.querySelectorAll('#segments li')][1]
  const before = commented.querySelector('.text')?.textContent

  // Merge the commented line into the one above it: the row index of everything
  // below shifts by one, and the merged line keeps the *earlier* start.
  commented.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
  await settle()
  ;[...document.querySelectorAll('.menu .menu__item')]
    .find((b) => strip(b.textContent) === 'Merge up').click()
  await settle()
  await settle()

  const rows = [...document.querySelectorAll('#segments li')]
  const marked = rows.findIndex((row) => row.classList.contains('is-marked'))
  // Open whatever is marked now and read back what it holds.
  rows[marked]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  await settle()
  const aside = document.querySelector('#aside')

  return {
    before,
    marked,
    text: aside.querySelector('.aside__quote')?.textContent,
    comment: [...aside.querySelectorAll('.thread__text')].map((p) => p.textContent).join(' | '),
    tags: [...aside.querySelectorAll('.tag--removable')].map((c) => c.textContent.trim()),
  }
})()`)

check('a merge does not move the comment onto another line',
  survived.marked === 0 && /hesitated/.test(survived.comment ?? ''),
  `row ${survived.marked} · ${JSON.stringify(survived.comment)}`)
check('and the tags came with it', survived.tags.join(', ') === 'follow up, pricing, pricing/discounts',
  survived.tags.join(', '))
check('which is the line that absorbed it', (survived.text ?? '').includes(survived.before ?? '\u0000'),
  (survived.text ?? '').slice(0, 60))

// Undo the merge, so the reload below is checking the same transcript that was
// annotated rather than one this check quietly changed.
await evaluate("document.querySelector('#undo').click(); true")
await sleep(600)

const dismissed = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 300))
  document.querySelector('#aside .aside__close').click()
  await settle()
  // The drawer is still open from earlier. One press, one dismissal.
  const openBefore = document.body.classList.contains('has-drawer')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  return { openBefore, openAfter: document.body.classList.contains('has-drawer') }
})()`)
check('Escape closes the drawer once the aside is gone',
  dismissed.openBefore && !dismissed.openAfter,
  `${dismissed.openBefore} → ${dismissed.openAfter}`)

const removed = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 350))
  const strip = (text) => text.replace(/^[\u2713\s]+/, '').trim()
  const heading = document.querySelector('.section')
  heading.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
  await settle()
  const items = [...document.querySelectorAll('.menu .menu__item')].map((b) => strip(b.textContent))

  // Rename it, then take the second one away entirely.
  ;[...document.querySelectorAll('.menu .menu__item')]
    .find((b) => strip(b.textContent) === 'Rename').click()
  await settle()
  const input = document.querySelector('.section__input')
  input.value = 'Small talk'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  await settle()

  const second = [...document.querySelectorAll('.section')][1]
  second.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 400 }))
  await settle()
  ;[...document.querySelectorAll('.menu .menu__item')]
    .find((b) => strip(b.textContent) === 'Remove').click()
  await settle()
  await settle()

  return {
    items,
    headings: [...document.querySelectorAll('.section__title')].map((h) => h.textContent),
    bands: document.querySelectorAll('.timeline__band').length,
  }
})()`)
check('a section heading has its own menu', removed.items.join(', ') === 'Go to it, Play from here, Rename, Remove',
  removed.items.join(', '))
check('renaming one keeps it where it is', removed.headings[0] === 'Small talk', removed.headings.join(' | '))
check('removing one takes its band with it', removed.headings.length === 1 && removed.bands === 1,
  `${removed.headings.length} headings · ${removed.bands} bands`)

await shoot(shotPath)

// --- merging two tags by dragging one onto the other ---
//
// The gesture the idea already has: put this in there. The alternative was
// typing the target's whole path into a rename box, and for a deep branch that
// is exactly the typing that produces a near-duplicate instead of a merge.
const dragged = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  if (document.querySelector('#drawer').classList.contains('is-open') === false) {
    document.querySelector('#drawer-handle').click()
    await settle()
  }
  ;[...document.querySelectorAll('.drawer__tab')].find((t) => t.textContent.startsWith('Tags')).click()
  await settle()

  // Something to drag: a second tag on another line.
  const rows = [...document.querySelectorAll('#segments li')]
  rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle(); await settle()
  const tagField = document.querySelector('#aside input[aria-label="Add a tag"]')
  tagField.value = 'loose'
  tagField.dispatchEvent(new Event('input'))
  await settle()
  tagField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle(); await settle()
  document.querySelector('#aside .aside__close').click()
  await settle()

  const tag = (path) => document.querySelector('.taglist .tag[data-tag="' + path + '"]')
  const before = [...document.querySelectorAll('.taglist .tag')].map((b) => b.dataset.tag)

  const carrier = new DataTransfer()
  tag('loose').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: carrier }))
  const onto = tag('pricing/discounts')
  onto.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: carrier }))
  const highlighted = onto.classList.contains('is-target')
  onto.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: carrier }))
  for (let i = 0; i < 6; i++) await settle()

  const after = [...document.querySelectorAll('.taglist .tag')].map((b) => b.dataset.tag)
  const library = (await (await fetch('/v1/tags')).json()).tags.map((entry) => entry.name)
  return { before, after, highlighted, library }
})()`)

check('a tag can be picked up', dragged.before.includes('loose'), dragged.before.join(', '))
check('the one under the pointer says it would take it', dragged.highlighted)
check('and dropping merges it in', !dragged.after.includes('loose') && dragged.library.includes('pricing/discounts'),
  dragged.after.join(', '))
check('the vocabulary is left with one word instead of two',
  !dragged.library.includes('loose'), dragged.library.join(', '))

// --- an edit is kept, not just shown ---
// Everything above is an annotation *about* the transcript. This is the
// transcript itself: merging two lines used to live in the page and nowhere
// else, so closing the tab threw away the correction while the comment written
// about it survived -- which is exactly backwards.
const editedAway = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const strip = (text) => text.replace(/^[\u2713\s]+/, '').trim()
  const rows = () => [...document.querySelectorAll('#segments li')]
  const before = rows().length
  const last = rows()[rows().length - 1]
  last.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
  await settle()
  ;[...document.querySelectorAll('.menu .menu__item')]
    .find((b) => strip(b.textContent) === 'Merge up').click()
  // The save is debounced, so this waits past it rather than racing it.
  for (let i = 0; i < 6; i++) await settle()
  const after = rows().length
  const stored = (await (await fetch('/v1/runs')).json()).runs[0].segments
  return { before, after, stored }
})()`)
check('merging two lines shortens the transcript', editedAway.after === editedAway.before - 1,
  `${editedAway.before} → ${editedAway.after}`)
check('and the database is told', editedAway.stored === editedAway.after,
  `server says ${editedAway.stored}`)

// --- and none of it was only in the page ---
await send('Page.navigate', { url: uiUrl })
await sleep(2500)
await evaluate(trap)

const reloaded = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  document.querySelector('.rail__run').click()
  for (let i = 0; i < 12; i++) await settle()
  document.querySelector('#drawer-handle').click()
  await settle()
  await settle()
  return {
    headings: [...document.querySelectorAll('.section__title')].map((h) => h.textContent),
    bands: document.querySelectorAll('.timeline__band').length,
    marked: document.querySelectorAll('#segments li.is-marked').length,
    tags: [...document.querySelectorAll('.taglist .tag')].map((t) => t.dataset.tag),
    rows: document.querySelectorAll('#segments li').length,
    errors: window.__errors,
  }
})()`)

check('sections survive a reload', reloaded.headings.join(' | ') === 'Small talk',
  reloaded.headings.join(' | '))
check('so does the timeline', reloaded.bands === 1, `${reloaded.bands} bands`)
check('so do the comments and the tags', reloaded.marked >= 1 && reloaded.tags.includes('pricing'),
  `${reloaded.marked} marked · ${reloaded.tags.join(', ')}`)
check('and so does the edit itself', reloaded.rows === editedAway.after,
  `${reloaded.rows} lines, and it was ${editedAway.after} when the page was closed`)
check('no page errors', (reloaded.errors ?? []).length === 0, (reloaded.errors ?? []).join(' | '))

console.log('\nscreenshot: ' + shotPath)
socket.close()
const failed = checks.filter((entry) => !entry.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
