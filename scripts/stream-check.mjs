#!/usr/bin/env node
/**
 * Does the transcript appear while it is being written?
 *
 * Needs a *long* recording to be worth checking: on a thirty-second clip the run
 * is over in two seconds and "it appeared as it went" is indistinguishable from
 * "it appeared at the end". So this wants something measured in minutes, and it
 * asserts the interesting property directly — that the row count went up more
 * than once while the run was still going.
 *
 *   node scripts/stream-check.mjs http://127.0.0.1:9000/ <long-audio> [screenshot]
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, audioPath, shotPath = 'out/stream.png'] = process.argv.slice(2)
if (!uiUrl || !audioPath) {
  console.error('usage: node scripts/stream-check.mjs <ui-url> <long-audio> [screenshot]')
  process.exit(2)
}

const PORT = 9922 + Math.floor(Math.random() * 60)
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
   '--window-size=1280,900', 'about:blank'],
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

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Page.navigate', { url: uiUrl })
await sleep(2500)
await evaluate(`window.__errors = []
  addEventListener('error', (e) => __errors.push(String(e.message)))
  addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)))
  true`)

const { root } = await send('DOM.getDocument')
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
await send('DOM.setFileInputFiles', { nodeId, files: [audioPath] })
await evaluate(`document.querySelector('#file').dispatchEvent(new Event('change'))
  document.querySelector('#submit').click(); true`)

// Wait for the job to exist before starting the clock. Uploading a 189 MB file
// out of a browser takes minutes on its own, and nothing can render until the
// bytes have arrived — timing from the click would measure the upload.
const uploadStarted = Date.now()
while (Date.now() < uploadStarted + 900_000) {
  if (await evaluate(`!!localStorage.getItem('hexscribe:job')`)) break
  await sleep(1000)
}
const uploadSeconds = (Date.now() - uploadStarted) / 1000

// Watch the row count while the run is going. Growth *during* the run is the
// whole claim; a single jump at the end would be the old behaviour.
const samples = []
let firstRowsAt = null
const startedAt = Date.now()
const deadline = startedAt + 900_000
while (Date.now() < deadline) {
  const state = await evaluate(`({
    rows: document.querySelectorAll('#segments li').length,
    done: document.querySelector('#drop').dataset.state === 'done',
    hint: document.querySelector('#drop-hint').textContent,
  })`)
  if (state.rows && firstRowsAt === null) firstRowsAt = Date.now() - startedAt
  if (!state.done) samples.push(state.rows)
  if (state.done) break
  await sleep(2000)
}

const growth = samples.filter((count, index) => index > 0 && count > samples[index - 1]).length
const peakWhileRunning = Math.max(0, ...samples)
check('utterances render before the run is over', peakWhileRunning > 0, `${peakWhileRunning} rows while running`)
check('and keep arriving as it goes', growth >= 3, `${growth} increases across ${samples.length} samples`)
// One job on the NPU. Two hour-long runs at once push this past four minutes,
// which is contention rather than a regression -- but the threshold stays where
// it is, because a check that passes under any conditions checks nothing.
check('the first ones show up soon after the run begins', firstRowsAt !== null && firstRowsAt < 90_000,
  `${firstRowsAt === null ? 'never' : (firstRowsAt / 1000).toFixed(1) + 's'} after the job started` +
    ` (the upload itself took ${uploadSeconds.toFixed(0)}s)`)

// "Editable" measured by asking a row to be edited, not by reading the Undo
// button: Undo is enabled by an edit having happened, so a finished transcript
// nobody has touched has it disabled and always did. The property that matters
// is that the rows now carry the handlers the live view withheld -- the server
// was still appending to that one, and an edit made against it would have been
// overwritten by the next poll.
const final = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 300))
  const text = document.querySelector('#segments li .text')
  text?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await settle()
  const editor = document.querySelector('#segments .editor')
  const editable = Boolean(editor)
  // Leave it as it was found: Escape cancels without changing the text.
  editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  return {
    rows: document.querySelectorAll('#segments li').length,
    state: document.querySelector('#drop').dataset.state,
    editable,
    hint: document.querySelector('#drop-hint').textContent,
  }
})()`)
// Fewer rows at the end than at the peak is correct, not a loss: the merge pass
// rejoins sentences the decoder split at a window boundary, and it can only run
// once every window has been decoded.
check('and the finished transcript replaces the live one', final.rows > 0,
  `${peakWhileRunning} while running → ${final.rows} after merging`)
check('which is editable, as the live one was not', final.editable,
  'double-click opens the row editor')
check('finishing in the done state', final.state === 'done', `${final.state} — ${final.hint}`)

const errors = await evaluate('window.__errors')
check('no page errors', errors.length === 0, errors.join(' | '))

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(shotPath, Buffer.from(data, 'base64'))
console.log(`\nscreenshot: ${shotPath}`)
socket.close()
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
