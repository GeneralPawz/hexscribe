#!/usr/bin/env node
/**
 * Photograph the speaker panel with a *real* diarized transcript behind it.
 *
 * The main check runs without diarization (it is the same NPU work either way
 * and the interactions do not need it), so the panel it sees is the
 * hand-made-speaker case: no voice, nothing to remember. This one ticks the box
 * and opens the panel on a speaker the diarizer actually found, which is the
 * state the feature exists for and the only one that shows the enrolment
 * controls doing anything.
 *
 *   node scripts/panel-shot.mjs http://127.0.0.1:9000/ test\fixtures\x.m4a out\panel.png [en]
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, audioPath, shotPath = 'out/panel.png', language = 'en'] = process.argv.slice(2)
if (!uiUrl || !audioPath) {
  console.error('usage: node scripts/panel-shot.mjs <ui-url> <audio> [screenshot] [language]')
  process.exit(2)
}

const PORT = 9422 + Math.floor(Math.random() * 200)
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
   '--autoplay-policy=no-user-gesture-required', '--window-size=1017,900', 'about:blank'],
  { stdio: 'ignore' },
)
process.on('exit', () => chrome.kill())

async function attach() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Page.navigate', { url: uiUrl })
await new Promise((resolve) => setTimeout(resolve, 2500))

const { root } = await send('DOM.getDocument')
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
await send('DOM.setFileInputFiles', { nodeId, files: [audioPath] })
await evaluate(`
  document.querySelector('#file').dispatchEvent(new Event('change'))
  document.querySelector('#language').value = ${JSON.stringify(language)}
  document.querySelector('#diarize').checked = true
  document.querySelector('#submit').click()
  true`)

const deadline = Date.now() + 600_000
while (Date.now() < deadline) {
  if (await evaluate('!document.querySelector("#result").hidden')) break
  await sleep(500)
}

const found = await evaluate(`(async () => {
  const chips = [...document.querySelectorAll('#segments li .speaker')]
  chips[0]?.click()
  await new Promise((r) => setTimeout(r, 400))
  return {
    speakers: [...new Set(chips.map((c) => c.textContent))],
    remembers: !document.querySelector('#aside')?.textContent.includes('created by hand'),
  }
})()`)

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(shotPath, Buffer.from(data, 'base64'))
console.log(`speakers: ${found.speakers.join(', ')}`)
console.log(`panel offers to remember the voice: ${found.remembers}`)
console.log(`screenshot: ${shotPath}`)
socket.close()
process.exit(found.remembers ? 0 : 1)
