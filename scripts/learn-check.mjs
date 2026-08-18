#!/usr/bin/env node
/**
 * Does a correction teach the library anything?
 *
 * The claim this checks is the one that is easy to write and hard to believe:
 * that assigning a line to somebody the app already knows makes the *next*
 * recording easier, rather than only fixing this transcript. So it names a
 * voice, moves two lines of a different speaker onto that name, and then asks
 * the server whether the stored print actually grew.
 *
 * It also exercises the two selection behaviours around it, because both are
 * ways to touch many things at once and both are worth being sure of: a menu
 * that says how many utterances it is about to change, and a rail that can
 * delete several runs.
 *
 * Runs against a throwaway database (serve.mjs --db), because it deletes what
 * it makes.
 *
 *   node scripts/learn-check.mjs http://127.0.0.1:9000/ <diarized-audio> <short-audio>
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, first, second] = process.argv.slice(2)
if (!uiUrl || !first || !second) {
  console.error('usage: node scripts/learn-check.mjs <ui-url> <diarized-audio> <short-audio>')
  process.exit(2)
}

const NAME = 'Mara Check'
const PORT = 9622 + Math.floor(Math.random() * 200)
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chrome = spawn(
  CHROME,
  ['--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
   '--window-size=1200,900', 'about:blank'],
  { stdio: 'ignore' },
)
process.on('exit', () => chrome.kill())

async function attach() {
  for (let attempt = 0; attempt < 40; attempt++) {
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

const failures = []
const check = (ok, what, detail = '') => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail ? ' \u2014 ' + detail : ''))
  if (!ok) failures.push(what)
}

const voices = async () => (await (await fetch(new URL('/v1/voices', uiUrl))).json()).voices
const runs = async () => (await (await fetch(new URL('/v1/runs', uiUrl))).json()).runs

async function transcribe(path, diarize) {
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
  await send('DOM.setFileInputFiles', { nodeId, files: [path] })
  await evaluate([
    "document.querySelector('#file').dispatchEvent(new Event('change'))",
    "document.querySelector('#language').value = 'en'",
    "document.querySelector('#diarize').checked = " + diarize,
    "document.querySelector('#submit').click()",
    'true',
  ].join('\n'))
  const deadline = Date.now() + 900_000
  while (Date.now() < deadline) {
    if (await evaluate('document.querySelector("#drop").dataset.state === "done"')) return
    await sleep(500)
  }
  throw new Error(path + ' did not finish')
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Page.navigate', { url: uiUrl })
await sleep(2500)

const startingVoices = await voices()
check(!startingVoices.some((voice) => voice.name === NAME), 'the scratch library starts without the test voice')

await transcribe(first, true)
await sleep(800)

// --- name a speaker ------------------------------------------------------
const enrolled = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 500))
  const chips = [...document.querySelectorAll('#segments li .speaker')]
  const speakers = [...new Set(chips.map((c) => c.textContent))]
  chips[0].click()
  await settle()
  const panel = document.querySelector('#aside')
  const input = panel.querySelector('input[type="text"]')
  input.value = ${JSON.stringify(NAME)}
  input.dispatchEvent(new Event('input'))
  await settle()
  const save = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save')
  save.click()
  await settle()
  await settle()
  return {
    speakers,
    said: [...panel.querySelectorAll('.aside__note')].map((n) => n.textContent).join(' | '),
    chipsNow: [...new Set([...document.querySelectorAll('#segments li .speaker')].map((c) => c.textContent))],
  }
})()`)

check(enrolled.speakers.length >= 2, 'the recording has several speakers to move lines between',
  enrolled.speakers.join(', '))
check(enrolled.chipsNow.includes(NAME), 'the named speaker now reads as the name', enrolled.chipsNow.join(', '))

const afterEnroll = (await voices()).find((voice) => voice.name === NAME)
check(Boolean(afterEnroll), 'the name reached the library')
check(afterEnroll?.recordings === 1, 'as one recording', 'recordings=' + afterEnroll?.recordings)

// --- correct two lines of somebody else ----------------------------------
const corrected = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const rows = [...document.querySelectorAll('#segments li')]
  const label = (row) => row.querySelector('.speaker')?.textContent ?? ''
  const wrong = rows.filter((row) => label(row) && label(row) !== ${JSON.stringify(NAME)}).slice(0, 2)
  if (wrong.length < 2) return { error: 'not enough rows belonging to another speaker' }

  const ctrlClick = (row) => row.dispatchEvent(
    new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 400, clientY: 400 }))
  wrong.forEach(ctrlClick)
  await settle()
  const toolbar = document.querySelector('#toolbar-count').textContent

  // Right-click the row, not the chip: the row menu is the per-utterance one,
  // and the question is whether it admits it is about to change two of them.
  const index = rows.indexOf(wrong[0])
  const other = rows.indexOf(wrong[1])
  const live = [...document.querySelectorAll('#segments li')]
  live[index].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
  await settle()
  const strip = (text) => text.replace(/^[\\u2713\\s]+/, '').trim()
  const labels = [...document.querySelectorAll('.menu .menu__item, .menu .menu__heading')].map((n) => strip(n.textContent))
  const change = [...document.querySelectorAll('.menu .menu__item')]
    .find((b) => b.textContent.includes('Change speaker'))
  const changeLabel = change ? strip(change.textContent) : ''
  change?.click()
  await settle()
  const target = [...document.querySelectorAll('.menu .menu__item')]
    .find((b) => b.textContent.includes(${JSON.stringify(NAME)}))
  if (!target) return { error: 'the speaker menu did not offer the named voice', labels }
  target.click()
  await settle()
  await settle()
  await settle()

  const now = [...document.querySelectorAll('#segments li')]
  return {
    toolbar,
    labels,
    changeLabel,
    movedTo: [index, other].map((i) => now[i].querySelector('.speaker')?.textContent),
    hint: document.querySelector('#drop-hint').textContent,
  }
})()`)

if (corrected.error) {
  check(false, 'the correction could be made', corrected.error + ' ' + JSON.stringify(corrected.labels ?? []))
} else {
  check(corrected.toolbar.includes('2'), 'two rows are selected', corrected.toolbar)
  check(corrected.changeLabel === 'Change speaker \u00b7 2 selected',
    'the menu says how many utterances it will change', corrected.changeLabel)
  check(corrected.movedTo.every((label) => label === NAME), 'both rows moved to the named speaker',
    corrected.movedTo.join(', '))
  check(/learned 2 utterances for/.test(corrected.hint), 'the app says it learned from the correction',
    corrected.hint)
}

const afterLearn = (await voices()).find((voice) => voice.name === NAME)
check(afterLearn?.recordings === 2, 'the print took the correction as new evidence',
  'recordings ' + afterEnroll?.recordings + ' \u2192 ' + afterLearn?.recordings)
check((afterLearn?.seconds ?? 0) > (afterEnroll?.seconds ?? 0), 'and grew by the corrected speech',
  afterEnroll?.seconds?.toFixed(1) + 's \u2192 ' + afterLearn?.seconds?.toFixed(1) + 's')

// --- a second run, then delete both from the rail ------------------------
await evaluate("document.querySelector('#rail-new').click(); true")
await sleep(500)
await transcribe(second, false)
await sleep(1500)

check((await runs()).length >= 2, 'two runs are stored')

const railed = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const buttons = () => [...document.querySelectorAll('#rail .rail__run')]
  const before = buttons().length
  for (const button of buttons()) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  }
  await settle()
  const bar = document.querySelector('#rail-selection')
  const shown = !bar.hidden
  const count = document.querySelector('#rail-selected-count').textContent
  const picked = document.querySelectorAll('#rail .rail__run.is-picked').length
  const remove = document.querySelector('#rail-delete')
  const offered = remove.textContent
  remove.click()
  await settle()
  const armed = remove.textContent
  remove.click()
  for (let i = 0; i < 20 && buttons().length; i++) await settle()
  return {
    before, shown, count, picked, offered, armed,
    left: buttons().length,
    empty: document.querySelector('#rail-runs').textContent.trim(),
    barGone: document.querySelector('#rail-selection').hidden,
  }
})()`)

check(railed.before >= 2, 'the rail lists both runs', String(railed.before))
check(railed.shown && railed.count === railed.before + ' selected', 'ctrl+click selects them', railed.count)
check(railed.picked === railed.before, 'and marks each one', String(railed.picked))
check(railed.offered === 'Delete ' + railed.before, 'the button says how many', railed.offered)
check(railed.armed === 'Really delete ' + railed.before + '?', 'the first click only arms it', railed.armed)
check(railed.left === 0 && railed.empty === 'Nothing yet', 'the second click deletes them', railed.empty)
check(railed.barGone, 'and the selection bar goes away')

const remaining = await runs()
check(remaining.length === 0, 'the server agrees they are gone', remaining.length + ' left')

socket.close()
console.log(failures.length ? '\n' + failures.length + ' failed' : '\nall good')
process.exit(failures.length ? 1 : 0)
