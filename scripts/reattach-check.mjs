#!/usr/bin/env node
/**
 * Does a transcription survive the page that started it?
 *
 * That is the whole claim of moving the work off the request, and it is not
 * observable from inside one page load: this starts a run, reloads the browser
 * mid-flight — which is as close to "closed the tab" as a check can get while
 * still being able to look afterwards — and asserts the page finds the run again
 * and ends up with the transcript.
 *
 *   node scripts/reattach-check.mjs http://127.0.0.1:9000/ <audio> [screenshot]
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, audioPath, shotPath = 'out/reattach.png'] = process.argv.slice(2)
if (!uiUrl || !audioPath) {
  console.error('usage: node scripts/reattach-check.mjs <ui-url> <audio-file> [screenshot]')
  process.exit(2)
}

const PORT = 9822 + Math.floor(Math.random() * 150)
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
   '--window-size=1017,900', 'about:blank'],
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

const { root } = await send('DOM.getDocument')
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
await send('DOM.setFileInputFiles', { nodeId, files: [audioPath] })
await evaluate(`document.querySelector('#file').dispatchEvent(new Event('change'))
  document.querySelector('#submit').click(); true`)

// Wait until the job exists, then throw the page away mid-run.
let stored = null
for (let i = 0; i < 40 && !stored; i++) {
  await sleep(150)
  stored = await evaluate(`localStorage.getItem('hexscribe:job')`)
}
check('a job was started and remembered', !!stored, stored ?? '(none)')

await send('Page.navigate', { url: 'about:blank' })
await sleep(400)
console.log('  (page discarded mid-transcription)')
await send('Page.navigate', { url: uiUrl })
await sleep(1500)

const reattached = await evaluate(`({
  state: document.querySelector('#drop').dataset.state,
  hint: document.querySelector('#drop-hint').textContent,
  stillStored: !!localStorage.getItem('hexscribe:job'),
})`)
check('the reloaded page picks the run back up',
  reattached.state === 'busy' || reattached.state === 'done', `${reattached.state} — ${reattached.hint}`)

// And then finishes on its own, without the file being dropped again.
const deadline = Date.now() + 600_000
let done = false
while (Date.now() < deadline) {
  done = await evaluate(`!document.querySelector('#result').hidden`)
  if (done) break
  await sleep(500)
}
const finished = await evaluate(`({
  segments: document.querySelectorAll('#segments li').length,
  state: document.querySelector('#drop').dataset.state,
  cleared: localStorage.getItem('hexscribe:job') === null,
  errors: document.querySelector('#error').hidden,
})`)
check('and shows the transcript it never asked for twice', done && finished.segments > 0,
  `${finished.segments} segments`)
check('finishing in the finished state', finished.state === 'done', finished.state)
check('with the job let go', finished.cleared)
check('and no error on screen', finished.errors)

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(shotPath, Buffer.from(data, 'base64'))
console.log(`\nscreenshot: ${shotPath}`)
socket.close()
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
