#!/usr/bin/env node
/**
 * End-to-end check of the browser UI, driven over the Chrome DevTools Protocol.
 *
 * The node test suite covers the server and the pure helpers, but the parts that
 * broke in practice were the ones only a browser exercises: a progress bar that
 * would not hide, downloads that silently lost their speaker labels, timestamps
 * that looked clickable and were not. This drives the real page — pick a file,
 * transcribe, click a timestamp, read back what happened — and screenshots it.
 *
 * Needs a running server, Chrome, and a local recording. It is not part of
 * `npm test`: it wants the NPU and takes as long as a transcription.
 *
 *   .\hexscribe.ps1 serve --port 9000
 *   node scripts/ui-check.mjs http://127.0.0.1:9000/ test\fixtures\One_Speaker_de.wav out\ui.png
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [uiUrl, audioPath, shotPath = 'out/ui-check.png'] = process.argv.slice(2)
if (!uiUrl || !audioPath) {
  console.error('usage: node scripts/ui-check.mjs <ui-url> <audio-file> [screenshot]')
  process.exit(2)
}

const PORT = 9222 + Math.floor(Math.random() * 200)
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    // A scripted click is not a user gesture, so playback would stay paused and
    // the check could not tell "blocked by policy" from "cannot decode".
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1017,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const shutdown = () => chrome.kill()
process.on('exit', shutdown)
process.on('SIGINT', () => process.exit(130))

async function attach() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is not listening yet.
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

const until = async (expression, label, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const shoot = async (path) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(data, 'base64'))
}

const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')

// The field is drawn differently in the two themes -- a glow that carries on a
// dark ground washes out on white, and it was once invisible in light because of
// exactly that. `HEXSCRIBE_SCHEME=light` runs the whole check in the other one.
if (process.env.HEXSCRIBE_SCHEME) {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: process.env.HEXSCRIBE_SCHEME }],
  })
}
await send('Page.navigate', { url: uiUrl })
await until('document.readyState === "complete" && !!document.querySelector("#file")', 'page load', 30_000)

await evaluate(`window.__errors = [];
  addEventListener('error', (e) => __errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)));
  true`)

check('idle state reported', (await evaluate(`document.querySelector('#drop').dataset.state`)) === 'waiting')
check('idle field mounted', await evaluate(`!!document.querySelector('#drop > canvas.field')`))

// Dragging a file over the zone should make it look more awake than it did a
// second ago. The energy is inside the shader, so the observable is the class
// the same handler sets -- and that a drag does not disturb the tone.
const dragging = await evaluate(`(async () => {
  const drop = document.querySelector('#drop')
  drop.dispatchEvent(new DragEvent('dragenter', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  const over = drop.classList.contains('is-over')
  const toneWhileOver = drop.dataset.tone
  drop.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  return { over, toneWhileOver, cleared: !drop.classList.contains('is-over') }
})()`)
check('dragging a file over the zone registers', dragging.over && dragging.cleared)
check('and does not change what colour the field is', dragging.toneWhileOver === 'idle',
  dragging.toneWhileOver)

const { root } = await send('DOM.getDocument')
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })
await send('DOM.setFileInputFiles', { nodeId, files: [audioPath] })
await evaluate(`document.querySelector('#file').dispatchEvent(new Event('change')); true`)
check('file accepted', await evaluate(`!document.querySelector('#submit').disabled`))
check('armed state reported', (await evaluate(`document.querySelector('#drop').dataset.state`)) === 'armed')

// Headless Chrome will not grant notification permission, and the point of the
// feature is what it says rather than that the OS accepted it — so the platform
// is stubbed and the calls are recorded.
await evaluate(`window.__notifications = []
  class FakeNotification {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, options) {
      window.__notifications.push({ title, ...options })
    }
    close() {}
  }
  window.Notification = FakeNotification
  const box = document.querySelector('#notify')
  box.checked = true
  box.dispatchEvent(new Event('change'))
  true`)
check('notifications are offered where the browser has them',
  await evaluate(`!document.querySelector('#notify-field').hidden`))

// The page should be using the background path, so the POST returns a receipt
// and the transcript arrives by polling. Watch the network for the receipt.
await evaluate(`window.__receipt = null
  const realFetch = window.fetch
  window.fetch = async (...args) => {
    const response = await realFetch(...args)
    if (response.status === 202) window.__receipt = await response.clone().json()
    return response
  }
  true`)

await evaluate(`document.querySelector('#submit').click(); true`)
const startedState = await evaluate(`({ ...document.querySelector('#drop').dataset })`)
check('working state reported', startedState.state === 'busy')
// Not "eventually amber": the run has already begun, so a fade-in would spend
// its first second still looking idle. Read on the very next turn, no sleep.
check('and the field is already on the working tone', startedState.tone === 'busy', startedState.tone)

// The field *is* the progress indicator, so the states have to be seen, not
// just asserted. Catch it mid-flight before the result replaces it.
await sleep(1200)
await shoot(shotPath.replace(/\.png$/, '-busy.png'))

// Background: the request that started this has already returned, and the page
// is polling. The receipt proves it, and the stored id is what lets a reload
// find the run again.
const receipt = await evaluate('window.__receipt')
check('the transcription runs as a job, not on the request', !!receipt?.id, receipt?.id ?? '(none)')
check('and the page remembers it, so a reload can find it again',
  (await evaluate(`JSON.parse(localStorage.getItem('hexscribe:job') || '{}').id`)) === receipt?.id)
const midFlight = await evaluate(`document.querySelector('#drop-hint').textContent`)
check('progress is reported while it runs', /reading the file|\d+%/.test(midFlight), midFlight)

await until('!document.querySelector("#result").hidden', 'transcription', 600_000)
await shoot(shotPath.replace(/\.png$/, '-done.png'))

const segments = await evaluate(`document.querySelectorAll('#segments li').length`)
check('segments rendered', segments > 0, `${segments} segments`)
check('the job is let go once its result is on screen',
  (await evaluate(`localStorage.getItem('hexscribe:job')`)) === null)
check('and the title stops reporting progress',
  !/%/.test(await evaluate('document.title')), await evaluate('document.title'))

const notifications = await evaluate('window.__notifications')
const finish = notifications[notifications.length - 1]
check('Windows is told when it finishes', /^Transcribed /.test(finish?.title ?? ''), finish?.title ?? '(none)')
check('and told what it got', /utterances/.test(finish?.body ?? ''), finish?.body ?? '')
check('progress notifications replace rather than pile up',
  notifications.every((n) => n.tag === 'hexscribe-progress'),
  `${notifications.length} shown, ${new Set(notifications.map((n) => n.tag)).size} tag(s)`)
check('and only the last one makes a sound',
  notifications.slice(0, -1).every((n) => n.silent === true) && finish?.silent !== true)
const finishedState = await evaluate(`({ ...document.querySelector('#drop').dataset })`)
check('finished state reported', finishedState.state === 'done')
check('and the field lands on the finished tone', finishedState.tone === 'done', finishedState.tone)
check('player visible', await evaluate(`!document.querySelector('#audio').hidden`))
check('timestamps are buttons', (await evaluate(`document.querySelectorAll('.seek').length`)) === segments)

const seek = await evaluate(`(async () => {
  const buttons = [...document.querySelectorAll('.seek')]
  const target = buttons[Math.min(2, buttons.length - 1)]
  const wanted = target.textContent.split(':').reduce((m, part) => m * 60 + Number(part), 0)
  target.click()
  await new Promise((r) => setTimeout(r, 900))
  const audio = document.querySelector('#audio')
  const rows = [...document.querySelectorAll('#segments li')]
  return {
    wanted,
    currentTime: audio.currentTime,
    playing: !audio.paused,
    activeRow: rows.findIndex((row) => row.classList.contains('is-active')),
    expectedRow: buttons.indexOf(target),
  }
})()`)
check('clicking a timestamp seeks there', Math.abs(seek.currentTime - seek.wanted) < 2.5,
  `wanted ${seek.wanted}s, got ${seek.currentTime.toFixed(2)}s`)
check('and starts playing', seek.playing)
check('and highlights that utterance', seek.activeRow === seek.expectedRow)

// Editing utterance boundaries. These are pointer interactions now -- Ctrl+click
// to select, right-click for a menu -- so they are driven as real events.
const editing = await evaluate(`(async () => {
  const rows = () => [...document.querySelectorAll('#segments li')]
  const textOf = (row) => row.querySelector('.text')?.textContent ?? ''
  const settle = () => new Promise((r) => setTimeout(r, 120))
  const ctrlClick = (row) => row.dispatchEvent(
    new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  const rightClick = (target, x, y) => target.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
  // Aim at a glyph, not at the span's box: the span stretches past the end of a
  // short line, and a point in that empty space is not "here" in the text --
  // the menu correctly refuses to split there, which reads as a broken check.
  const overCharacter = (element, at) => {
    const range = document.createRange()
    range.setStart(element.firstChild, at)
    range.setEnd(element.firstChild, at + 1)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  const middleOf = (element) => overCharacter(element, Math.floor(element.textContent.length / 2))
  const menuItem = (label) =>
    [...document.querySelectorAll('.menu__item')].find((b) => b.textContent.startsWith(label))

  const before = rows().length
  const firstText = textOf(rows()[0])

  // --- Ctrl+click two rows, then merge from the action beside the selection ---
  ctrlClick(rows()[0]); await settle()
  ctrlClick(rows()[1]); await settle()
  const selectedCount = document.querySelectorAll('#segments li.is-selected').length
  const toolbarShown = !document.querySelector('#toolbar').hidden
  const actionLabel = document.querySelector('#merge-selected')?.textContent ?? ''

  // --- assign a speaker to the whole selection from the toolbar ---
  document.querySelector('#speaker-selected').click()
  await settle()
  const speakerMenuItems = [...document.querySelectorAll('.menu__item')].map((b) => b.textContent.replace('✓', ''))
  menuItem('New speaker')?.click()
  await settle()
  const chips = document.querySelectorAll('#segments li .speaker').length
  const chipIsButton = document.querySelector('#segments li .speaker')?.tagName === 'BUTTON'

  // --- and change it back from the row menu ---
  // Not from the chip: the chip opens the speaker *panel* now, because it is
  // the person. Which speaker said a given utterance is a different question
  // and lives here and in the toolbar.
  const speakerRow = rows()[0]
  const speakerAim = middleOf(speakerRow.querySelector('.text'))
  rightClick(speakerRow.querySelector('.text'), speakerAim.x, speakerAim.y)
  await settle()
  const rowMenuHasSpeaker = !!menuItem('Change speaker')
  menuItem('Change speaker')?.click()
  await settle()
  const changeMenuOpen = !!document.querySelector('.menu')
  menuItem('No speaker')?.click()
  await settle()
  const chipsAfterClear = document.querySelectorAll('#segments li .speaker').length

  // --- Escape gives the selection back ---
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  const clearedByEscape = document.querySelectorAll('#segments li.is-selected').length === 0
    && document.querySelector('#toolbar').hidden

  ctrlClick(rows()[0]); await settle()
  ctrlClick(rows()[1]); await settle()
  document.querySelector('#merge-selected')?.click()
  await settle()
  const afterMerge = rows().length
  const toolbarGone = document.querySelector('#toolbar').hidden

  // --- right-click in the middle of the text, split there ---
  const text = rows()[0].querySelector('.text')
  const middle = middleOf(text)
  rightClick(text, middle.x, middle.y)
  await settle()
  const menuOpened = !!document.querySelector('.menu')
  const splitItem = menuItem('Split here')
  const splitEnabled = splitItem && !splitItem.disabled
  splitItem?.click()
  await settle()
  const afterSplit = rows().length
  const menuClosed = !document.querySelector('.menu')

  // --- right-click again, correct the text ---
  const editTarget = rows()[0].querySelector('.text')
  const editAim = overCharacter(editTarget, 1)
  rightClick(editTarget, editAim.x, editAim.y)
  await settle()
  menuItem('Edit text')?.click()
  await settle()
  const editorOpen = !!document.querySelector('.editor')
  const editor = document.querySelector('.editor')
  if (editor) {
    editor.value = 'Korrigierter Text'
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  await settle()
  const editedText = textOf(rows()[0])
  const editedMark = document.querySelectorAll('#segments li.is-edited').length

  // --- double-click the text to correct it ---
  const target = rows()[0].querySelector('.text')
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await settle()
  const dblclickOpensEditor = !!document.querySelector('.editor')
  const dblEditor = document.querySelector('.editor')
  if (dblEditor) {
    dblEditor.value = 'Doppelklick korrigiert'
    dblEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  await settle()
  const dblclickCommitted = textOf(rows()[0]) === 'Doppelklick korrigiert'

  // --- play from a point inside an utterance, not from its start ---
  const playRow = rows()[0]
  // [0-9] rather than \\d: this whole block is a template literal, which eats a
  // backslash escape it does not know and would leave the regex matching "d".
  const startOf = (row) => Number(/PT([0-9.]+)S/.exec(row.querySelector('time').dateTime)[1])
  const rowStart = startOf(playRow)
  const nextStart = rows()[1] ? startOf(rows()[1]) : null // null: nothing after it
  const aim = middleOf(playRow.querySelector('.text'))
  rightClick(playRow.querySelector('.text'), aim.x, aim.y)
  await settle()
  const playOffered = !!menuItem('Play from here')
  menuItem('Play from here')?.click()
  // Seeking sets currentTime synchronously; read it before playback moves on.
  const playedFrom = document.querySelector('#audio').currentTime
  await settle()

  // --- undo everything back ---
  const undo = document.querySelector('#undo')
  // Every edit above is one step; the bound is a runaway guard, not a count.
  for (let i = 0; i < 20 && !undo.disabled; i++) { undo.click(); await settle() }

  return {
    before, selectedCount, toolbarShown, actionLabel, afterMerge, toolbarGone,
    speakerMenuItems, chips, chipIsButton, rowMenuHasSpeaker, changeMenuOpen, chipsAfterClear, clearedByEscape,
    menuOpened, splitEnabled, afterSplit, menuClosed, editorOpen, editedText, editedMark,
    playOffered, playedFrom, rowStart, nextStart,
    dblclickOpensEditor, dblclickCommitted,
    menuHasNoHints: !document.querySelector('.menu__hint'),
    restored: rows().length,
    restoredText: textOf(rows()[0]) === firstText,
  }
})()`)

check('ctrl+click selects rows', editing.selectedCount === 2, `${editing.selectedCount} selected`)
check('the toolbar appears with the selection', editing.toolbarShown)
check('and offers to merge the run', /^Merge 2/.test(editing.actionLabel), editing.actionLabel)
check('the toolbar assigns a speaker in bulk', editing.chips === 2, `${editing.chips} chips`)
check('the speaker chip is clickable', editing.chipIsButton)
check('the row menu can reassign a speaker', editing.rowMenuHasSpeaker && editing.changeMenuOpen)
check('the speaker menu lists what exists', editing.speakerMenuItems.includes('New speaker'),
  editing.speakerMenuItems.join(', '))
check('and can clear the speaker again', editing.chipsAfterClear === 0)
check('escape gives the selection back', editing.clearedByEscape)
check('merging the run leaves one row', editing.afterMerge === editing.before - 1,
  `${editing.before} -> ${editing.afterMerge}`)
check('the toolbar goes when the selection does', editing.toolbarGone)
check('the row menu carries no explanatory text', editing.menuHasNoHints)
check('right-click opens the row menu', editing.menuOpened)
check('split is offered at the pointer', editing.splitEnabled)
check('and splits the row there', editing.afterSplit === editing.afterMerge + 1)
check('the menu closes after choosing', editing.menuClosed)
check('edit opens an editor', editing.editorOpen)
check('and Enter commits the correction', editing.editedText === 'Korrigierter Text', editing.editedText)
check('a corrected row is marked', editing.editedMark === 1)
check('double-clicking the text opens the editor too', editing.dblclickOpensEditor)
check('and commits the same way', editing.dblclickCommitted)
check('the row menu offers to play from the pointer', editing.playOffered)
check(
  'and playback starts inside the utterance, not at its start',
  editing.playedFrom > editing.rowStart && editing.playedFrom < (editing.nextStart ?? Infinity),
  `row ${editing.rowStart}s..${editing.nextStart ?? '∞'}s, played from ${editing.playedFrom?.toFixed(2)}s`,
)
check('undo walks all of it back', editing.restored === editing.before && editing.restoredText)

// The right-hand panel: one panel, two contents, and it must be gone by default.
const aside = await evaluate(`(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 200))
  const panel = document.querySelector('#aside')
  const hiddenAtRest = panel.hidden

  // --- the download panel, from the single Download button ---
  document.querySelector('#download').click()
  await settle()
  const downloadOpened = !panel.hidden && panel.classList.contains('is-open')
  const downloadTitle = panel.querySelector('.aside__title')?.textContent
  const formats = [...panel.querySelectorAll('option')].map((o) => o.value)
  const hasFileName = [...panel.querySelectorAll('.aside__field')]
    .some((f) => f.textContent.includes('File name'))
  const oldButtonsGone = document.querySelectorAll('[data-download]').length === 0
  const movedOver = document.body.classList.contains('has-aside')

  // Actually download: the panel opening proves nothing about whether the
  // configured export reaches the server and comes back.
  const select = panel.querySelector('select')
  select.value = 'srt'
  const fileField = [...panel.querySelectorAll('input[type="text"]')].pop()
  fileField.value = 'from-the-panel'
  ;[...panel.querySelectorAll('button')].find((b) => b.textContent === 'Download')?.click()
  await new Promise((r) => setTimeout(r, 900))
  const downloadSaid = panel.querySelector('.aside__note--ok')?.textContent ?? ''

  // Escape closes it even with focus outside the panel.
  document.querySelector('#segments li')?.focus()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  const closedByEscape = panel.hidden

  // --- the same panel, showing a speaker ---
  // Give a row a speaker first: this recording may have been transcribed
  // without diarization, and the chip is what opens the panel.
  const rows = [...document.querySelectorAll('#segments li')]
  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  await settle()
  document.querySelector('#speaker-selected').click()
  await settle()
  ;[...document.querySelectorAll('.menu__item')]
    .find((b) => b.textContent.startsWith('New speaker'))?.click()
  await settle()

  const chip = document.querySelector('#segments li .speaker')
  chip?.click()
  await settle()
  const speakerOpened = !panel.hidden
  const speakerTitle = panel.querySelector('.aside__title')?.textContent
  const nameInput = panel.querySelector('input[type="text"]')
  const nameStarts = nameInput?.value
  const saysNoVoice = panel.textContent.includes('created by hand')

  // Renaming applies to every utterance of that speaker, not just this row.
  nameInput.value = 'Ada Lovelace'
  nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  const chipText = document.querySelector('#segments li .speaker')?.textContent
  const renamedRows = [...document.querySelectorAll('#segments li .speaker')]
    .filter((c) => c.textContent === 'Ada Lovelace').length

  document.querySelector('.aside__close').click()
  await settle()

  return {
    hiddenAtRest, downloadOpened, downloadTitle, formats, hasFileName, oldButtonsGone,
    movedOver, downloadSaid,
    closedByEscape, speakerOpened, speakerTitle, nameStarts, saysNoVoice, chipText,
    renamedRows, closedByButton: panel.hidden,
  }
})()`)

check('the panel is not there until something asks for it', aside.hiddenAtRest)
check('one Download button, not four', aside.oldButtonsGone)
check('and it opens the panel', aside.downloadOpened && aside.downloadTitle === 'Download',
  aside.downloadTitle)
check('offering every format', ['srt', 'vtt', 'text', 'json'].every((f) => aside.formats.includes(f)),
  aside.formats.join(', '))
check('and a file name to save under', aside.hasFileName)
check('the page moves over rather than being covered', aside.movedOver)
check('and the configured download completes', /^Saved from-the-panel\.srt$/.test(aside.downloadSaid),
  aside.downloadSaid || '(no confirmation)')
check('escape closes the panel from anywhere on the page', aside.closedByEscape)
check('clicking a speaker chip opens the same panel', aside.speakerOpened && aside.speakerTitle === 'Speaker',
  aside.speakerTitle)
check('showing the speaker it was opened on', /^(S\\d+|SPEAKER_)/.test(aside.nameStarts ?? ''), aside.nameStarts)
check('and saying plainly when there is no voice to remember', aside.saysNoVoice)
check('renaming reaches every utterance of that speaker', aside.renamedRows >= 1 && aside.chipText === 'Ada Lovelace',
  `${aside.renamedRows} rows show "${aside.chipText}"`)
check('the close button closes it', aside.closedByButton)

// "It stays green until something new is dropped" is a claim about a timer that
// must *not* fire, and the only way to check that is to wait past when the old
// one did (4 s) and look again.
await sleep(5000)
const heldState = await evaluate(`({ ...document.querySelector('#drop').dataset })`)
check('the finished tone holds instead of settling back', heldState.tone === 'done',
  `${heldState.state}/${heldState.tone}`)

// Leave the two new interactions on screen and photograph them: "a merge action
// appears beside the selection" is a claim about pixels.
await evaluate(`(async () => {
  const rows = [...document.querySelectorAll('#segments li')]
  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  await new Promise((r) => setTimeout(r, 150))
})()`)
await shoot(shotPath.replace(/\.png$/, '-selection.png'))

await evaluate(`(async () => {
  const text = document.querySelector('#segments li .text')
  const box = text.getBoundingClientRect()
  text.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, clientX: box.left + box.width / 3, clientY: box.top + 8,
  }))
  await new Promise((r) => setTimeout(r, 150))
})()`)
await shoot(shotPath.replace(/\.png$/, '-menu.png'))

const errors = await evaluate('window.__errors')
check('no page errors', errors.length === 0, errors.join(' | '))

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(shotPath, Buffer.from(data, 'base64'))
console.log(`\nscreenshot: ${shotPath}`)

socket.close()
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
