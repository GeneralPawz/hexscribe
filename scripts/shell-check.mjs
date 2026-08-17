#!/usr/bin/env node
/**
 * The application shell: rail, history, settings, and the file picker.
 *
 * Separate from `ui-check.mjs` because it needs no NPU and no recording — it
 * exercises the parts around the transcript rather than the transcript itself,
 * and those are the parts that break when a route moves. It does want a run in
 * the database to click on, so it transcribes one small file first if the
 * history is empty.
 *
 *   node scripts/shell-check.mjs http://127.0.0.1:9000/ [audio] [screenshot]
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, audioPath, shotPath = 'out/shell.png'] = process.argv.slice(2)
if (!uiUrl) {
  console.error('usage: node scripts/shell-check.mjs <ui-url> [audio-file] [screenshot]')
  process.exit(2)
}

// The folder the picker gets pointed at: wherever the sample recording lives,
// so no path is baked into this script.
const fixtures = audioPath ? dirname(resolve(audioPath)) : ''

const PORT = 9522 + Math.floor(Math.random() * 150)
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
   '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' },
)
process.on('exit', () => chrome.kill())

async function attach() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page')
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
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value

const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
}
const shoot = async (path) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Page.navigate', { url: uiUrl })
await sleep(2500)

await evaluate(`window.__errors = []
  addEventListener('error', (e) => __errors.push(String(e.message)))
  addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)))
  true`)

// --- the rail ---
const rail = await evaluate(`({
  brand: document.querySelector('.rail__title')?.textContent,
  taglineGone: !document.querySelector('.tagline'),
  headingGone: !document.querySelector('main h1'),
  collapsed: Math.round(document.querySelector('#rail').getBoundingClientRect().width),
  items: [...document.querySelectorAll('.rail__item .rail__label')].map((l) => l.textContent),
  settingsLast: document.querySelector('.rail__foot #rail-settings') !== null,
  statusInRail: document.querySelector('.rail__foot #status') !== null,
})`)
check('the title lives in the rail', rail.brand === 'hexscribe', rail.brand)
check('and not above the transcript', rail.taglineGone && rail.headingGone)
check('the rail is collapsed at rest', rail.collapsed < 70, `${rail.collapsed}px`)
check('carrying New, Jobs and Settings', rail.items.join(',').includes('Jobs'), rail.items.join(', '))
check('with Settings at the bottom', rail.settingsLast && rail.statusInRail)

// The rail widens on hover. Driven as a real pointer move, because :hover is
// not something a script can fake with a class.
const box = await evaluate(`(() => { const r = document.querySelector('#rail').getBoundingClientRect(); return { x: r.x + 10, y: r.y + 60 } })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
await sleep(400)
const hovered = await evaluate(`Math.round(document.querySelector('#rail').getBoundingClientRect().width)`)
check('and expands on hover', hovered > 180, `${rail.collapsed}px → ${hovered}px`)
await shoot(shotPath.replace(/\.png$/, '-rail.png'))

// --- make sure there is a run to click on ---
let runs = await evaluate(`(async () => (await (await fetch('/v1/runs')).json()).runs.length)()`)
if (!runs && audioPath) {
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
  await send('DOM.setFileInputFiles', { nodeId, files: [audioPath] })
  await evaluate(`document.querySelector('#file').dispatchEvent(new Event('change'))
    document.querySelector('#submit').click(); true`)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (await evaluate(`!document.querySelector('#result').hidden`)) break
    await sleep(500)
  }
  await sleep(1500)
  runs = await evaluate(`(async () => (await (await fetch('/v1/runs')).json()).runs.length)()`)
}
check('the run history has something in it', runs > 0, `${runs} runs`)

// --- jobs list, and opening one ---
await send('Page.navigate', { url: uiUrl })
await sleep(2000)
// The reload threw the previous trap away with the old document.
await evaluate(`window.__errors = []
  addEventListener('error', (e) => __errors.push(String(e.message)))
  addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)))
  true`)
const listed = await evaluate(`({
  rows: document.querySelectorAll('.rail__run').length,
  count: document.querySelector('#rail-jobs-count')?.textContent,
  firstName: document.querySelector('.rail__run-name')?.textContent,
  firstMeta: document.querySelector('.rail__run-meta')?.textContent,
})`)
check('past runs are listed in the rail', listed.rows > 0, `${listed.rows} rows, badge "${listed.count}"`)
check('each row says which run it is', Boolean(listed.firstName), `${listed.firstName} — ${listed.firstMeta}`)

const opened = await evaluate(`(async () => {
  document.querySelector('.rail__run').click()
  await new Promise((r) => setTimeout(r, 1200))
  return {
    segments: document.querySelectorAll('#segments li').length,
    resultShown: !document.querySelector('#result').hidden,
    asideOpen: !document.querySelector('#aside').hidden,
    asideTitle: document.querySelector('.aside__title')?.textContent,
    asideName: document.querySelector('.aside__name')?.textContent,
    marked: document.querySelectorAll('.rail__run.is-active').length,
    hasStats: document.querySelectorAll('#aside .aside__stat').length,
    player: !document.querySelector('#audio').hidden,
  }
})()`)
check('clicking a run brings it into the main pane', opened.resultShown && opened.segments > 0,
  `${opened.segments} utterances`)
check('and opens the aside with its details', opened.asideOpen && opened.asideTitle === 'Run',
  `${opened.asideTitle}: ${opened.asideName}`)
check('showing what the run cost', opened.hasStats >= 6, `${opened.hasStats} facts`)
check('and marking it in the rail', opened.marked === 1)
check('with playback, because the audio was kept', opened.player)
await shoot(shotPath.replace(/\.png$/, '-run.png'))

// --- settings ---
const settings = await evaluate(`(async () => {
  document.querySelector('#rail-settings').click()
  await new Promise((r) => setTimeout(r, 900))
  const modal = document.querySelector('#modal')
  return {
    open: modal.open,
    title: modal.querySelector('.modal__title')?.textContent,
    sections: [...modal.querySelectorAll('.modal__section-title')].map((h) => h.textContent),
    fields: [...modal.querySelectorAll('.modal__field > span')].map((s) => s.textContent),
    dbPath: modal.querySelector('.modal__input--path')?.value,
    stats: [...modal.querySelectorAll('.modal__stat')].map((s) => s.textContent),
    resetDisabled: [...modal.querySelectorAll('button')].find((b) => b.textContent.includes('whole database'))?.disabled,
  }
})()`)
check('Settings opens as a modal', settings.open && settings.title === 'Settings')
check('with defaults, storage and a danger zone', settings.sections.length === 3, settings.sections.join(' · '))
check('offering the settings that are global', settings.fields.join(',').includes('Language'), settings.fields.join(', '))
check('naming the database and its size', /hexscribe\.db$/.test(settings.dbPath ?? ''), settings.dbPath)
check('and reporting what is in it', settings.stats.some((s) => /Database size/.test(s)), settings.stats.join(' | '))
check('the irreversible button starts disabled', settings.resetDisabled === true)

const armed = await evaluate(`(async () => {
  const modal = document.querySelector('#modal')
  const input = [...modal.querySelectorAll('input[type="text"]')].find((i) => i.placeholder === 'delete everything')
  input.value = 'delete everything'
  input.dispatchEvent(new Event('input'))
  await new Promise((r) => setTimeout(r, 100))
  return [...modal.querySelectorAll('button')].find((b) => b.textContent.includes('whole database'))?.disabled
})()`)
check('and is only enabled once the words are typed', armed === false)
await shoot(shotPath.replace(/\.png$/, '-settings.png'))

await evaluate(`document.querySelector('#modal').close(); true`)
await sleep(300)

// --- the file picker ---
const picker = await evaluate(`(async () => {
  const shown = !document.querySelector('#browse-row').hidden
  document.querySelector('#browse').click()
  await new Promise((r) => setTimeout(r, 1200))
  const modal = document.querySelector('#modal')
  return {
    shown,
    open: modal.open,
    title: modal.querySelector('.modal__title')?.textContent,
    folder: modal.querySelector('.modal__input--path')?.value,
    entries: modal.querySelectorAll('.picker__entry').length,
    folders: modal.querySelectorAll('.picker__entry.is-folder').length,
  }
})()`)
check('the on-disk option is offered', picker.shown)
check('and opens a browser rooted in the home folder', picker.open && Boolean(picker.folder), picker.folder)
check('listing folders to walk through', picker.entries > 0 && picker.folders > 0,
  `${picker.entries} entries, ${picker.folders} folders`)
await shoot(shotPath.replace(/\.png$/, '-picker.png'))

// --- and actually transcribe from disk, which is the point of the picker ---
const fromDisk = await evaluate(`(async () => {
  const modal = document.querySelector('#modal')
  const folder = modal.querySelector('.modal__input--path')
  folder.value = ${JSON.stringify(fixtures)}
  folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise((r) => setTimeout(r, 900))
  const file = [...modal.querySelectorAll('.picker__entry')].find((b) => !b.classList.contains('is-folder'))
  const name = file?.querySelector('.picker__name')?.textContent
  file?.click()
  await new Promise((r) => setTimeout(r, 500))
  return {
    name,
    closed: !modal.open,
    title: document.querySelector('#drop-title').textContent,
    hint: document.querySelector('#drop-hint').textContent,
    armed: !document.querySelector('#submit').disabled,
  }
})()`)
check('picking a file arms the form without uploading', fromDisk.armed && fromDisk.closed,
  `${fromDisk.title} — ${fromDisk.hint}`)
check('and says the bytes will stay where they are', /nothing will be uploaded/.test(fromDisk.hint ?? ''))

const ran = await evaluate(`(async () => {
  window.__uploaded = null
  const realFetch = window.fetch
  window.fetch = async (input, init) => {
    if (init?.body instanceof FormData && String(input).includes('/v1/audio/')) {
      window.__uploaded = { hasFile: init.body.has('file'), hasPath: init.body.has('path') }
    }
    return realFetch(input, init)
  }
  document.querySelector('#submit').click()
  await new Promise((r) => setTimeout(r, 800))
  return window.__uploaded
})()`)
check('the request names the file instead of carrying it', ran?.hasPath === true && ran?.hasFile === false,
  JSON.stringify(ran))

const finished = await (async () => {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (await evaluate(`!document.querySelector('#result').hidden`)) break
    await sleep(500)
  }
  await sleep(1200)
  return evaluate(`(async () => {
    const runs = (await (await fetch('/v1/runs')).json()).runs
    return { segments: document.querySelectorAll('#segments li').length, source: runs[0]?.source, path: runs[0]?.path }
  })()`)
})()
check('and it transcribes', finished.segments > 0, `${finished.segments} utterances`)
check('recorded as a disk run that remembers its file', finished.source === 'disk' && Boolean(finished.path),
  finished.path ?? '(none)')

const errors = await evaluate('window.__errors')
check('no page errors', errors.length === 0, errors.join(' | '))

await shoot(shotPath)
console.log(`\nscreenshot: ${shotPath}`)
socket.close()
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
