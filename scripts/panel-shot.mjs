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

// Not "the result is visible": utterances render as they are decoded, so the
// panel appears long before the run is over -- and long before diarization has
// produced a single speaker. The drop zone only reaches `done` at the end.
const deadline = Date.now() + 600_000
while (Date.now() < deadline) {
  if (await evaluate('document.querySelector("#drop").dataset.state === "done"')) break
  await sleep(500)
}
await sleep(800)

const found = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400))
  const chips = [...document.querySelectorAll('#segments li .speaker')]
  chips[0]?.click()
  await settle()
  const panel = document.querySelector('#aside')
  const nameInput = panel.querySelector('input[type="text"]')

  // The name field is a dropdown over the voices already known, and it says
  // what saving under a given name would do -- join that person, or make a new
  // one. That difference is otherwise invisible, and getting it wrong splits
  // somebody's evidence across two prints.
  const listId = nameInput?.getAttribute('list')
  const known = listId ? [...document.querySelectorAll('#' + listId + ' option')].map((o) => o.value) : []
  const describe = async (value) => {
    nameInput.value = value
    nameInput.dispatchEvent(new Event('input'))
    await settle()
    return [...panel.querySelectorAll('.aside__note')]
      .map((n) => n.textContent)
      .find((line) => /Adds this voice to|new voice/.test(line)) ?? ''
  }
  const joins = known.length ? await describe(known[0]) : ''
  const fresh = await describe('Somebody Not In The Library')

  return {
    speakers: [...new Set(chips.map((c) => c.textContent))],
    remembers: !panel.textContent.includes('created by hand'),
    known,
    joins,
    fresh,
  }
})()`)

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(shotPath, Buffer.from(data, 'base64'))
console.log(`speakers: ${found.speakers.join(', ')}`)
console.log(`panel offers to remember the voice: ${found.remembers}`)
console.log(`name dropdown lists: ${found.known.join(', ') || '(nothing)'}`)
console.log(`picking a known name says: ${found.joins || '(silent)'}`)
console.log(`typing a new one says:     ${found.fresh || '(silent)'}`)
console.log(`screenshot: ${shotPath}`)
socket.close()
const ok = found.remembers && found.known.length > 0 && /Adds this voice to/.test(found.joins) && /new voice/.test(found.fresh)
process.exit(ok ? 0 : 1)
