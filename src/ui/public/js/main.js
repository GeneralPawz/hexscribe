/** Wiring: picks up a file, asks the API, shows the result. */

import {
  deleteRun,
  detachAudio,
  getHealth,
  getVoices,
  learnVoice,
  getJob,
  getModels,
  getRun,
  getRuns,
  getSettings,
  hasJobs,
  hasLocalFiles,
  transcribe,
} from './api.js'
import { closeModal, openModal } from './modal.js'
import { describeRun, mountRail } from './rail.js'
import { settingsModal } from './settings.js'
import { filePicker } from './picker.js'
import { runPanel } from './panel-run.js'
import { $, clock, humanSize, show } from './dom.js'
import {
  notificationsSupported,
  notifyDone,
  notifyProgress,
  requestNotifications,
  setTitleProgress,
} from './notify.js'
import { markActive, mountResult } from './transcript.js'
import { mountShader } from './shader.js'
import { activeIndex, createPlayer } from './player.js'
import { estimateSeconds, progressAt, recordRtf } from './progress.js'
import {
  isContiguous,
  mergeAt,
  mergeRange,
  mergeSpeakersInTranscript,
  nextSpeakerName,
  speakerSummary,
  setSpeaker,
  setText,
  speakerNames,
  splitAt,
  timeAt,
} from './segments.js'
import { closeMenu, offsetFromPoint, openMenu } from './menu.js'
import { closeAside, isAsideOpen, openAside } from './aside.js'
import { speakerPanel } from './panel-speaker.js'
import { speakersPanel } from './panel-speakers.js'
import { downloadPanel } from './panel-download.js'

const els = {
  form: $('#form'),
  drop: $('#drop'),
  dropTitle: $('#drop-title'),
  dropHint: $('#drop-hint'),
  file: $('#file'),
  language: $('#language'),
  model: $('#model'),
  task: $('#task'),
  diarize: $('#diarize'),
  merge: $('#merge'),
  notify: $('#notify'),
  notifyField: $('#notify-field'),
  browseRow: $('#browse-row'),
  browse: $('#browse'),
  submit: $('#submit'),
  status: $('#status'),
  error: $('#error'),
  result: $('#result'),
  undo: $('#undo'),
  edited: $('#edited'),
  download: $('#download'),
  speakers: $('#speakers'),
  toolbar: $('#toolbar'),
  toolbarCount: $('#toolbar-count'),
  mergeSelected: $('#merge-selected'),
  speakerSelected: $('#speaker-selected'),
  clearSelected: $('#clear-selected'),
  audio: $('#audio'),
  segments: $('#segments'),
}

const HINT = 'or click to choose · anything FFmpeg can open'

/**
 * The drop zone is the progress indicator.
 *
 * There is no bar: the field behind the drop zone carries the state of the run —
 * speed for "something is happening", colour for *which* something. Waiting
 * drifts in the accent colour; working snaps to amber and runs fast, with no
 * fade-in, because the run has already started by the time the first frame
 * lands; finishing eases into green and slows down.
 *
 * Finished stays finished. The green is not a flash to be missed — it holds
 * until a new file arrives, which is the only thing that makes the last result
 * stale. Dropping one puts the field back to the beginning.
 */
const STATES = {
  waiting: { energy: 0.32, tone: 'idle', title: () => 'Drop audio here', hint: () => HINT },
  armed: {
    energy: 0.28,
    tone: 'idle',
    title: (about) => (about ? `${about.name} (${about.detail})` : 'Drop audio here'),
    hint: (about) => (about?.local ? 'on disk · nothing will be uploaded' : HINT),
  },
  busy: { energy: 1.0, tone: 'busy', snap: true, title: () => 'Transcribing…', hint: (_about, note) => note },
  done: {
    energy: 0.25,
    tone: 'done',
    title: (about) => about?.name ?? 'Finished',
    hint: (_about, note) => note,
  },
}

/**
 * What the drop zone is currently about.
 *
 * There are three ways to have audio in hand — dropped, chosen on disk, or a run
 * loaded from history — and the zone's label has to cope with all of them.
 * Reading `selected.name` directly was fine while an upload was the only kind,
 * and threw the moment a file on disk finished transcribing.
 */
function subject() {
  if (selected) return { name: selected.name, detail: humanSize(selected.size), local: false }
  if (chosen) return { name: chosen.name, detail: humanSize(chosen.bytes), local: true }
  if (viewing) return { name: viewing.name, detail: 'from history', local: viewing.source === 'disk' }
  return null
}

/**
 * Hovering, or dragging a file over the zone, lifts the pace to a middle gear.
 *
 * Not a state of its own — it keeps whatever colour the app is in and only
 * changes the tempo, because it is not news about the transcript. It is the
 * field saying "I can see you are about to give me something", which is the
 * one moment a drop zone should look more awake than it did a second ago.
 */
const INVITED_ENERGY = 0.62

let selected = null
/**
 * A file on this machine, chosen instead of uploaded.
 *
 * Mutually exclusive with `selected`: one of them is the audio for the next
 * run, and letting both be set would leave which one wins to reading order.
 */
let chosen = null
/** Whether this server can run the work off the request. Probed once, at boot. */
let canBackground = false
let canBrowse = false
/** Whether corrections feed back into the voice library. A setting. */
let learnEnabled = true
let rail = null
/** The stored run on screen, if the main pane is showing history rather than a new run. */
let viewing = null
/**
 * Which stored run the transcript on screen is, whichever way it got there.
 *
 * Not the same question as `viewing`, which means "opened from history". A run
 * that finished thirty seconds ago is just as much a row in the database, and
 * it is the one somebody is most likely to correct -- so anything that needs to
 * reach back to the recording (learning a voice from a fixed line) asks this
 * rather than asking whether the page came from the rail.
 */
let runId = null
let ticker = null
let player = null
let audioSeconds = 0

/**
 * The transcript on screen, which is not the one the server sent once the user
 * starts editing boundaries. Every consumer -- copy, downloads, the playback
 * highlight -- reads this, so an edit is reflected everywhere or nowhere.
 */
let current = null
let baseName = ''
let editing = null
/** Row positions picked with Ctrl+click, for a multi-row merge. */
const selectedRows = new Set()
const history = []

const field = mountShader(els.drop)

let stateName = 'waiting'
let invited = false

function setState(name, note = '') {
  const state = STATES[name]
  stateName = name
  els.drop.dataset.state = name
  els.drop.dataset.tone = state.tone
  const about = subject()
  els.dropTitle.textContent = state.title(about, note)
  els.dropHint.textContent = state.hint(about, note)
  applyMood()
}

/** Pointer over the zone, or a file being dragged onto it. */
function setInvited(value) {
  if (invited === value) return
  invited = value
  applyMood()
}

function applyMood() {
  const state = STATES[stateName]
  // Never while the NPU is running: there the pace is reporting something, and a
  // pointer passing over the zone is not allowed to change what it says.
  const lift = invited && stateName !== 'busy'
  field?.setMood(lift ? { ...state, energy: INVITED_ENERGY } : state)
}

function setError(message) {
  els.error.textContent = message ?? ''
  show(els.error, Boolean(message))
}

function selectFile(file) {
  if (!file) return
  chosen = null
  selected = file
  els.submit.disabled = false
  setError(null)
  viewing = null
  runId = null
  rail?.setActive(null)
  // A new file is what makes the last result stale, so this is where the
  // finished green goes back to the accent colour.
  setState('armed')

  // Load it into the player now, not after transcribing: the duration it
  // reports is what the progress estimate is built on.
  audioSeconds = 0
  player?.destroy()
  player = createPlayer(els.audio, file)
  els.audio.addEventListener('loadedmetadata', () => {
    audioSeconds = Number.isFinite(els.audio.duration) ? els.audio.duration : 0
  }, { once: true })
}

/**
 * A file named rather than uploaded.
 *
 * No `File` object exists for it, so there is nothing to hand the player until
 * the server streams it back — which it can, from the same path the transcriber
 * will read. That also means the duration is not known up front, so the first
 * seconds of a run show elapsed time rather than a percentage.
 */
function chooseLocal(file) {
  chosen = file
  selected = null
  els.submit.disabled = false
  setError(null)
  viewing = null
  runId = null
  rail?.setActive(null)

  audioSeconds = 0
  player?.destroy()
  player = createPlayer(els.audio, `/v1/files/audio?path=${encodeURIComponent(file.path)}`)
  els.audio.addEventListener('loadedmetadata', () => {
    audioSeconds = Number.isFinite(els.audio.duration) ? els.audio.duration : 0
  }, { once: true })

  setState('armed')
}

// --- editing utterance boundaries --------------------------------------

let lastWall = 0
let seekable = true

function render() {
  mountResult(current, lastWall, baseName, seekable ? (seconds) => player?.seek(seconds) : undefined, {
    selected: selectedRows,
    editing,
    onSelect: (position) => {
      selectedRows.has(position) ? selectedRows.delete(position) : selectedRows.add(position)
      render()
    },
    onEdit: (position, text) => {
      editing = null
      // null is a cancelled edit; an unchanged one returns the same array and
      // `edit` treats it as nothing happening.
      if (text === null) render()
      else edit(setText(current.segments, position, text))
    },
    onBeginEdit: beginEdit,
    onContext: (position, event, textElement) => openRowMenu(position, event, textElement),
    // The chip is the speaker, so clicking it asks about the *person*: who they
    // are, and what to remember them as. Which speaker said a given utterance is
    // a different question, and it lives in the row menu and the toolbar.
    onSpeaker: (position) => openSpeakerPanel(current.segments[position]?.speaker),
    onSpeakerMenu: (speaker, position, event) => openSpeakerChipMenu(speaker, position, event),
  })
  renderToolbar()
  els.undo.disabled = history.length === 0
  show(els.edited, history.length > 0)
}

/**
 * The selection toolbar, above the transcript and below the player.
 *
 * It exists only while rows are selected, because it belongs to the selection
 * rather than to the page — and putting it here instead of on the rows keeps
 * the transcript a document rather than a control panel.
 */
/**
 * Apply an edit and make it undoable.
 *
 * Every operation returns a new array, or the same one when it declined, which
 * is how a no-op stays out of the history. The transcript's own `text` is
 * rebuilt so copy and the downloads follow the edit too.
 */
function edit(segments) {
  if (segments === current.segments) return
  history.push(current.segments)
  current = { ...current, segments, text: segments.map((segment) => segment.text).join(' ') }
  render()
}

/** Open the editor on a row. Double-click and the row menu both land here. */
function beginEdit(position) {
  editing = position
  selectedRows.clear()
  render()
}

function renderToolbar() {
  const positions = [...selectedRows].sort((a, b) => a - b)
  show(els.toolbar, positions.length > 0)
  if (!positions.length) return

  const adjacent = isContiguous(positions)
  els.toolbarCount.textContent = adjacent
    ? `${positions.length} selected`
    : `${positions.length} selected · not adjacent`
  els.toolbarCount.classList.toggle('is-warning', !adjacent)
  // Merging a broken selection would silently swallow the rows between.
  els.mergeSelected.disabled = !adjacent || positions.length < 2
  els.mergeSelected.textContent = positions.length > 1 ? `Merge ${positions.length}` : 'Merge'
  // The count on both, so neither button is ambiguous about its reach.
  els.speakerSelected.textContent = positions.length > 1 ? `Speaker ${positions.length}` : 'Speaker'
}

/** Positions a speaker change applies to: the selection, or just this row. */
function speakerTargets(position) {
  return selectedRows.has(position) ? [...selectedRows].sort((a, b) => a - b) : [position]
}

/**
 * Everything this speaker says, under a new name.
 *
 * A rename is not an attribution change: the same person is still speaking the
 * same utterances, they are just no longer called `SPEAKER_01`. So it applies
 * everywhere the old label appears, in one undoable step, and the transcript's
 * voice print follows the name so the panel keeps describing the same voice.
 */
function renameSpeaker(from, to) {
  if (!current || from === to) return
  const positions = current.segments
    .map((segment, position) => (segment.speaker === from ? position : -1))
    .filter((position) => position >= 0)
  if (!positions.length) return

  const segments = setSpeaker(current.segments, positions, to)
  if (segments === current.segments) return

  history.push(current.segments)
  current = {
    ...current,
    segments,
    text: segments.map((segment) => segment.text).join(' '),
    voices: current.voices?.map((voice) =>
      voice.speaker === from ? { ...voice, speaker: to } : voice,
    ),
  }
  render()
}

/**
 * Which speaker the Speakers panel is examining.
 *
 * Held here rather than inside the panel because the panel is rebuilt on every
 * edit — merging speakers re-renders it — and losing your place each time you
 * merged would make merging six fragments six trips back.
 */
let examining = null

/** The speakers panel, on whichever tab makes sense. */
function openSpeakersPanel({ focus = examining, tab } = {}) {
  if (!current) return
  examining = focus ?? examining
  const handle = openAside(
    speakersPanel({
      transcript: current,
      focus: examining,
      onMerge: (names, into) => {
        const merged = mergeSpeakersInTranscript(current, names, into)
        if (merged === current) return
        history.push(current.segments)
        current = merged
        examining = into
        render()
        // Straight back to the list, which now has fewer rows in it: merging is
        // usually done several times in a row.
        openSpeakersPanel({ focus: into, tab: 'list' })
      },
      onJump: jumpTo,
      onOpenSpeaker: openSpeakerPanel,
      onFocus: (speaker) => openSpeakersPanel({ focus: speaker, tab: 'utterances' }),
    }),
  )
  if (tab) handle?.show(tab)
}

/**
 * Scroll the transcript to an utterance and play it.
 *
 * Both, because the question the panel is helping to answer — is this the same
 * person? — is answered by ear, and the row is what tells you where you are.
 */
function jumpTo(position) {
  const row = els.segments.children[position]
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    for (const other of els.segments.querySelectorAll('.is-jumped')) other.classList.remove('is-jumped')
    // Re-triggering the animation needs the class gone for a frame.
    requestAnimationFrame(() => row.classList.add('is-jumped'))
  }
  const segment = current?.segments[position]
  if (segment && seekable) player?.seek(segment.start)
}

/**
 * Right-click on a chip: this utterance, or this speaker.
 *
 * Both, and labelled as such. The chip is what you point at when a label is
 * wrong, and "wrong" means two completely different things — either the
 * diarizer put *this line* with the wrong person, or it split one person into
 * several and they all need joining. An earlier version of this menu offered
 * only the second, so the obvious click on a single misassigned line would have
 * moved every other line of that speaker with it.
 *
 * The counts are the safeguard: an action that says "7 utterances" cannot be
 * mistaken for one that says "this utterance".
 */
function openSpeakerChipMenu(speaker, position, event) {
  if (!speaker) return
  const summary = speakerSummary(current.segments)
  const mine = summary.find((entry) => entry.name === speaker)
  // Longest-speaking first, and only a handful: with a dozen speakers the tail
  // is one-utterance debris that nobody moves a line *to*, and a menu of
  // twenty-two entries is not a menu. `All speakers` opens the full list.
  const others = summary
    .filter((entry) => entry.name !== speaker)
    .sort((a, b) => b.seconds - a.seconds)
  const short = (name) => (name.startsWith('SPEAKER_') ? name.replace(/^SPEAKER_0*/, 'S') : name)

  // When rows are selected and this is one of them, the per-utterance half acts
  // on the selection -- the same rule the row menu and the toolbar already use.
  const targets = speakerTargets(position)
  const scope = targets.length > 1 ? `these ${targets.length} utterances` : 'this utterance'

  openMenu(event.clientX, event.clientY, [
    { heading: scope },
    ...others.slice(0, 5).map((entry) => ({
      label: `Move to ${short(entry.name)}`,
      onSelect: () => {
        edit(setSpeaker(current.segments, targets, entry.name))
        void learnFromAssignment(entry.name, targets)
      },
    })),
    {
      label: 'Move to a new speaker',
      onSelect: () => edit(setSpeaker(current.segments, targets, nextSpeakerName(current.segments))),
    },
    {
      label: 'Remove the label',
      onSelect: () => edit(setSpeaker(current.segments, targets, null)),
    },

    { heading: `${short(speaker)} · ${mine?.utterances ?? 0} utterances` },
    {
      label: 'Show utterances',
      onSelect: () => openSpeakersPanel({ focus: speaker, tab: 'utterances' }),
    },
    {
      label: 'All speakers',
      onSelect: () => openSpeakersPanel({ focus: speaker, tab: 'list' }),
    },
    {
      label: 'Name this speaker',
      onSelect: () => openSpeakerPanel(speaker),
    },
    // Whole-speaker, and it says how many it would take with it.
    ...others.slice(0, 3).map((entry) => ({
      label: `Merge all ${mine?.utterances ?? 0} into ${short(entry.name)}`,
      onSelect: () => {
        const merged = mergeSpeakersInTranscript(current, [speaker], entry.name)
        if (merged === current) return
        history.push(current.segments)
        current = merged
        render()
      },
    })),
  ])
}

function openSpeakerPanel(speaker) {
  if (!speaker) return
  openAside(
    speakerPanel({
      speaker,
      transcript: current,
      onRename: renameSpeaker,
      // Naming somebody here is what makes correcting a line afterwards worth
      // anything: a correction is only folded into a print when the name is one
      // the library holds, and until this runs the page does not know it does.
      onChanged: () => void refreshVoices(),
    }),
  )
}

/**
 * Names this machine already knows, so a correction can be learned from.
 *
 * Refreshed with the run list rather than per menu: it changes when somebody
 * names a speaker, which is rare, and asking on every right-click would put a
 * request between the pointer and the menu.
 */
let knownVoices = []

/**
 * Fold hand-assigned utterances into the voice they were assigned to.
 *
 * Only when the name is one the library already holds -- assigning to
 * `SPEAKER_04` teaches nothing, because there is nobody by that name to teach.
 * And only for a stored run, because the server needs the audio those
 * utterances came from and a run it has never recorded has none.
 *
 * The correction is the interesting part: these are lines the clustering got
 * wrong, so they are exactly the evidence the print was missing.
 */
async function learnFromAssignment(name, positions) {
  if (!learnEnabled || !runId) return
  if (!knownVoices.some((voice) => voice.name === name)) return

  const ranges = positions
    .map((position) => current.segments[position])
    .filter(Boolean)
    .map((segment) => ({ start: segment.start, end: segment.end }))
  if (!ranges.length) return

  try {
    const result = await learnVoice({ name, runId, ranges })
    if (result.learned) {
      setError(null)
      // Said out loud: it changed stored biometric data, quietly would be wrong.
      els.dropHint.textContent =
        `learned ${result.utterances} utterance${result.utterances === 1 ? '' : 's'} for ${name}`
    }
  } catch {
    // Never fatal. The assignment is what was asked for; the learning is a
    // bonus, and the audio may simply be gone.
  }
}

function openSpeakerMenu(x, y, positions) {
  const names = speakerNames(current.segments)
  const chosen = new Set(positions.map((position) => current.segments[position]?.speaker ?? null))
  const only = chosen.size === 1 ? [...chosen][0] : null

  openMenu(x, y, [
    ...names.map((name) => ({
      label: name,
      checked: only === name,
      onSelect: () => {
        edit(setSpeaker(current.segments, positions, name))
        void learnFromAssignment(name, positions)
      },
    })),
    {
      label: 'New speaker',
      onSelect: () => edit(setSpeaker(current.segments, positions, nextSpeakerName(current.segments))),
    },
    {
      label: 'No speaker',
      checked: only === null,
      onSelect: () => edit(setSpeaker(current.segments, positions, null)),
    },
  ])
}

els.mergeSelected.addEventListener('click', () => {
  const positions = [...selectedRows].sort((a, b) => a - b)
  if (positions.length < 2 || !isContiguous(positions)) return
  const merged = mergeRange(current.segments, positions[0], positions[positions.length - 1])
  selectedRows.clear()
  edit(merged)
})

els.speakerSelected.addEventListener('click', () => {
  const bounds = els.speakerSelected.getBoundingClientRect()
  openSpeakerMenu(bounds.left, bounds.bottom + 4, [...selectedRows].sort((a, b) => a - b))
})

els.speakers.addEventListener('click', () => openSpeakersPanel({ tab: 'list' }))

els.clearSelected.addEventListener('click', () => {
  selectedRows.clear()
  render()
})

els.download.addEventListener('click', () => {
  if (!current) return
  openAside(downloadPanel({ transcript: current, baseName }))
})

function openRowMenu(position, event, textElement) {
  const segment = current.segments[position]
  const offset = textElement ? offsetFromPoint(textElement, segment.text, event.clientX, event.clientY) : null
  const canSplit = offset !== null && offset > 0 && offset < segment.text.length

  openMenu(event.clientX, event.clientY, [
    {
      // Costs nothing that is not already here: the pointer's character offset
      // is what "split here" runs on, and turning an offset into a time is the
      // interpolation the split already does. A timestamp starts an utterance;
      // this starts a sentence in the middle of one.
      label: 'Play from here',
      disabled: !seekable,
      onSelect: () => {
        // Right-clicking the empty space past a short line resolves to the end
        // of the text, and playing an utterance's last instant is no use to
        // anyone. Anything that is not inside the words means the row itself.
        const inside = offset !== null && offset < segment.text.length
        player?.seek(inside ? timeAt(segment, offset) : segment.start)
      },
    },
    {
      label: 'Split here',
      disabled: !canSplit,
      onSelect: () => edit(splitAt(current.segments, position, offset)),
    },
    {
      label: 'Edit text',
      onSelect: () => {
        editing = position
        selectedRows.clear()
        render()
      },
    },
    {
      // Reassignment moved here when the chip took over identity. Both are
      // still one click from a row, and neither has to mean two things.
      //
      // Ctrl+click a run of rows first and this changes all of them -- so it
      // says so. An action that silently touched twelve rows because twelve
      // happened to be selected is the kind of surprise that costs trust once.
      label:
        speakerTargets(position).length > 1
          ? `Change speaker · ${speakerTargets(position).length} selected`
          : 'Change speaker',
      onSelect: () => openSpeakerMenu(event.clientX, event.clientY, speakerTargets(position)),
    },
    {
      label: 'Merge up',
      disabled: position === 0,
      onSelect: () => edit(mergeAt(current.segments, position - 1)),
    },
    {
      label: 'Merge down',
      disabled: position >= current.segments.length - 1,
      onSelect: () => edit(mergeAt(current.segments, position)),
    },
  ])
}

// One press, one dismissal, innermost outwards: the menu and the text editor
// consume Escape themselves while they are open, then the panel, then the
// selection. Everything below this line has already declined to handle it.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  // The dialog closes itself and tells `modal.js`, which is why there is no
  // branch for it here: by the time this runs, it is already gone.
  if (isAsideOpen()) {
    closeAside()
    return
  }
  if (!selectedRows.size) return
  selectedRows.clear()
  render()
})

els.undo.addEventListener('click', () => {
  const previous = history.pop()
  if (!previous) return
  editing = null
  selectedRows.clear()
  current = { ...current, segments: previous, text: previous.map((segment) => segment.text).join(' ') }
  render()
})

// --- drag and drop -----------------------------------------------------

els.drop.addEventListener('click', () => els.file.click())
els.drop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    els.file.click()
  }
})
els.file.addEventListener('change', () => selectFile(els.file.files[0]))

for (const type of ['dragenter', 'dragover']) {
  els.drop.addEventListener(type, (event) => {
    event.preventDefault()
    els.drop.classList.add('is-over')
    setInvited(true)
  })
}
for (const type of ['dragleave', 'drop']) {
  els.drop.addEventListener(type, (event) => {
    event.preventDefault()
    els.drop.classList.remove('is-over')
    setInvited(false)
  })
}
els.drop.addEventListener('drop', (event) => selectFile(event.dataTransfer?.files?.[0]))

// The same lift for a pointer resting on the zone, and for keyboard focus, which
// is the same intent arriving by a different route.
els.drop.addEventListener('pointerenter', () => setInvited(true))
els.drop.addEventListener('pointerleave', () => setInvited(false))
els.drop.addEventListener('focus', () => setInvited(true))
els.drop.addEventListener('blur', () => setInvited(false))

// --- submit ------------------------------------------------------------

els.form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!selected && !chosen) return

  setError(null)
  show(els.result, false)
  els.submit.disabled = true
  els.submit.textContent = 'Transcribing…'
  viewing = null
  runId = null
  rail?.setActive(null)

  const started = performance.now()
  const estimate = estimateSeconds(audioSeconds, { diarize: els.diarize.checked })
  baseName = (selected?.name ?? chosen.name).replace(/\.[^.]+$/, '')
  seekable = true

  setState('busy', '0.0 s')
  ticker = setInterval(() => {
    const elapsed = (performance.now() - started) / 1000
    // The field is a state now, not a ramp, so the estimate says its piece here
    // instead — in words, where it can be honest about being an estimate.
    els.dropHint.textContent = `${elapsed.toFixed(1)} s · about ${Math.round(progressAt(elapsed, estimate) * 100)}%`
  }, 100)

  try {
    const answer = await transcribe({
      file: selected,
      path: chosen?.path,
      model: els.model.value,
      language: els.language.value.trim(),
      task: els.task.value,
      diarize: els.diarize.checked,
      merge: els.merge.checked,
      background: canBackground,
    })

    // A receipt, or the transcript itself. The server decides which by whether
    // it has the jobs plugin; the page copes with either.
    // A job's id *is* the run's id -- `history.ts` records it under the same
    // one -- so this is where a fresh transcript learns which row it will be.
    if (answer.id && answer.status) runId = answer.id
    const transcript = answer.id && answer.status ? await followJob(answer, started) : answer
    if (!transcript) return // the job failed, and `followJob` has said so

    const wall = (performance.now() - started) / 1000
    recordRtf(transcript.duration, wall)
    showTranscript(transcript, wall)
  } catch (error) {
    setError(error.message)
    setState(selected || chosen ? 'armed' : 'waiting')
    setTitleProgress('')
  } finally {
    clearInterval(ticker)
    els.submit.disabled = !selected && !chosen
    els.submit.textContent = 'Transcribe'
    // However it went, it is history now.
    refreshRuns()
  }
})

/**
 * The transcript so far, while it is still being written.
 *
 * Deliberately not the editable view: the server is still appending, and an
 * edit made now would be overwritten by the next poll. So the rows render
 * without the selection, menu and editing handlers — they are there to read,
 * and they become editable the moment the run finishes.
 */
function showLive(live, wall) {
  current = live
  lastWall = wall
  mountResult(live, wall, baseName, seekable ? (seconds) => player?.seek(seconds) : undefined, {})
  els.undo.disabled = true
  show(els.edited, false)
  show(els.toolbar, false)
  show(els.result, true)
}

/** Put a finished transcript on screen. Shared by the live path and a reattach. */
function showTranscript(transcript, wall) {
  current = transcript
  history.length = 0
  editing = null
  selectedRows.clear()
  closeMenu()
  lastWall = wall
  render()
  player?.onTime((time) => markActive(els.segments, activeIndex(current.segments, time)))
  player?.onUnplayable(() => {
    // The browser cannot decode what the worker could. Re-render without the
    // seek buttons rather than leave dead ones behind.
    seekable = false
    render()
    setError('This file plays in the transcriber but not in the browser, so the timestamps are not clickable.')
  })
  show(els.result, true)

  // Ease into green and stay there: the transcript below is still the answer,
  // and a field that had drifted back to "ready" would say otherwise.
  setState('done', `done in ${wall.toFixed(1)} s`)
  setTitleProgress('')
}

// --- background jobs ---------------------------------------------------

const JOB_KEY = 'hexscribe:job'
/** A second is plenty: an utterance lands every few seconds at best. */
const POLL_MS = 1000

// Permission is the browser's answer; the checkbox is the user's. Both have to
// say yes, so unticking the box stops notifications without revoking anything.
const wanted = () => els.notify.checked
const tellProgress = (title, body, options) => wanted() && notifyProgress(title, body, options)
const tellDone = (title, body) => wanted() && notifyDone(title, body)

/**
 * Watch a running job until it settles.
 *
 * The estimate stops as soon as the first real number arrives, and the ticker
 * with it: a prediction is what you show when you have nothing, and the moment
 * the server can say "34 minutes of 79" the prediction is just noise competing
 * with the truth.
 *
 * @returns the finished transcript, or null when the job failed.
 */
async function followJob(receipt, started) {
  localStorage.setItem(JOB_KEY, JSON.stringify({ id: receipt.id, name: receipt.name }))
  let announced = -1

  // The transcript being built, shown as it is built. Held here rather than in
  // `current` until the job finishes, because until then it is not editable —
  // the server is still appending to it and an edit would be overwritten.
  const live = { segments: [], text: '', duration: 0, language: null }

  for (;;) {
    const job = await getJob(receipt.id, live.segments.length)
    if (!job) {
      localStorage.removeItem(JOB_KEY)
      throw new Error('That job is no longer on the server. It may have finished long ago, or the server restarted.')
    }

    if (job.status === 'running') {
      // The words, as they are decoded. Appended rather than re-rendered from
      // scratch so the reader's scroll position survives each poll.
      if (job.partial?.length) {
        live.segments.push(...job.partial)
        live.duration = job.progress.duration ?? 0
        live.text = live.segments.map((segment) => segment.text).join(' ')
        showLive(live, (performance.now() - started) / 1000)
      }

      // Real progress supersedes the estimate; until the file has been decoded
      // there is no duration and nothing honest to report but the elapsed time.
      if (job.progress.fraction !== undefined) {
        clearInterval(ticker)
        const percent = Math.round(job.progress.fraction * 100)
        els.dropHint.textContent =
          `${clock(job.progress.seconds)} of ${clock(job.progress.duration)} · ${percent}%`
        setTitleProgress(`${percent}%`)
        // Offered on every whole percent; `notify.js` decides how often it is
        // willing to actually rewrite the thing. Rewriting re-inserts it at the
        // top of the Action Center, which at one percent a second is a panel
        // that never sits still.
        if (percent !== announced) {
          announced = percent
          tellProgress(
            `Transcribing ${job.name}`,
            `${percent}% — ${clock(job.progress.seconds)} of ${clock(job.progress.duration)}`,
            { force: percent === 1 },
          )
        }
      } else {
        els.dropHint.textContent = 'reading the file…'
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      continue
    }

    localStorage.removeItem(JOB_KEY)
    clearInterval(ticker)

    if (job.status === 'failed') {
      setError(job.error ?? 'The transcription failed.')
      setState(selected ? 'armed' : 'waiting')
      setTitleProgress('')
      tellDone('Transcription failed', `${job.name}: ${job.error ?? 'unknown error'}`)
      return null
    }

    const wall = (performance.now() - started) / 1000
    tellDone(
      `Transcribed ${job.name}`,
      `${job.transcript.segments.length} utterances · ${clock(job.transcript.duration)} of audio in ${wall.toFixed(0)}s`,
    )
    return job.transcript
  }
}

/**
 * Pick up a job this page started before it was reloaded or closed.
 *
 * The whole point of moving the work off the request: closing the tab stops the
 * page, not the transcription. If one was running when the page went away, it
 * is very likely still running, and finding it again is better than starting it
 * over.
 */
async function reattach() {
  const stored = localStorage.getItem(JOB_KEY)
  if (!stored) return
  let receipt
  try {
    receipt = JSON.parse(stored)
  } catch {
    localStorage.removeItem(JOB_KEY)
    return
  }

  const job = await getJob(receipt.id).catch(() => null)
  if (!job || job.status === 'failed') {
    localStorage.removeItem(JOB_KEY)
    return
  }

  baseName = (receipt.name ?? 'transcript').replace(/\.[^.]+$/, '')
  runId = receipt.id
  // No file was dropped this time, so there is nothing to play: the audio never
  // left the browser that uploaded it, and this is a different page load.
  seekable = false
  selected = null
  els.dropTitle.textContent = receipt.name ?? 'Reattached'

  if (job.status === 'done') {
    localStorage.removeItem(JOB_KEY)
    showTranscript(job.transcript, (job.finished - job.created) / 1000)
    setState('done', `finished earlier · ${job.transcript.segments.length} utterances`)
    return
  }

  setState('busy', 'reattached — still transcribing')
  const transcript = await followJob(receipt, performance.now()).catch((error) => {
    setError(error.message)
    return null
  })
  if (transcript) showTranscript(transcript, (Date.now() - job.created) / 1000)
}

// --- history ------------------------------------------------------------

/** The voice library, as the page last saw it. Kept for `learnFromAssignment`. */
async function refreshVoices() {
  knownVoices = await getVoices().catch(() => knownVoices)
}

async function refreshRuns() {
  try {
    rail?.setRuns(await getRuns())
    await refreshVoices()
  } catch {
    // A missing history is not worth an error banner over a working transcript.
  }
}

/**
 * Show a run that finished earlier.
 *
 * The same rendering as a fresh one — it is the same shape, deliberately, so
 * there is one transcript view and not two. What differs is where the audio
 * comes from: a stored Opus copy, the file on disk it was read from, or nowhere,
 * in which case the timestamps go back to being text rather than pretending.
 */
async function openRun(id) {
  try {
    const run = await getRun(id)
    if (!run) {
      setError('That run is no longer in the database.')
      await refreshRuns()
      return
    }
    if (!run.transcript) {
      // A failed run has no transcript to show, but every reason to be looked
      // at — so the panel opens on its own with the error and the log.
      viewing = run
      runId = run.id
      rail?.setActive(id)
      show(els.result, false)
      openAside(runPanel(runPanelOptions(run)))
      return
    }

    viewing = run
    runId = run.id
    selected = null
    chosen = null
    els.submit.disabled = true
    setError(null)
    rail?.setActive(id)
    closeMenu()

    baseName = run.name.replace(/\.[^.]+$/, '')
    player?.destroy()
    player = null

    const url = run.has_audio
      ? `/v1/runs/audio?id=${encodeURIComponent(run.id)}`
      : run.source === 'disk' && run.path
        ? `/v1/files/audio?path=${encodeURIComponent(run.path)}`
        : null
    seekable = Boolean(url)
    if (url) player = createPlayer(els.audio, url)
    else els.audio.hidden = true

    current = run.transcript
    history.length = 0
    editing = null
    selectedRows.clear()
    lastWall = run.wall_ms / 1000
    render()
    if (player) {
      player.onTime((time) => markActive(els.segments, activeIndex(current.segments, time)))
      player.onUnplayable(() => {
        seekable = false
        render()
      })
    }
    show(els.result, true)

    // The drop zone still says what it is showing, without claiming to be busy.
    setState('done', describeRun(run))
    setTitleProgress('')

    openAside(runPanel(runPanelOptions(run)))
  } catch (error) {
    setError(error.message)
  }
}

function runPanelOptions(run) {
  return {
    run,
    onChanged: async () => {
      await refreshRuns()
      // Reopen against what is now true: dropping the audio changes what the
      // panel can offer and whether the timestamps still play.
      await openRun(run.id)
    },
    onDeleted: async () => {
      closeAside()
      viewing = null
      runId = null
      show(els.result, false)
      setState(selected || chosen ? 'armed' : 'waiting')
      await refreshRuns()
    },
    onResume: async (id) => {
      closeAside()
      await refreshRuns()
      // Follow it as a live job again: it is running, and the words carry on
      // appearing where they left off.
      const receipt = { id, name: run.name }
      runId = id
      setState('busy', 'resuming…')
      const transcript = await followJob(receipt, performance.now()).catch((error) => {
        setError(error.message)
        return null
      })
      if (transcript) showTranscript(transcript, (Date.now() - run.created) / 1000)
      await refreshRuns()
    },
    onBrowse: canBrowse
      ? (start) =>
          openModal(
            filePicker({
              start,
              onPick: async (file) => {
                try {
                  await detachAudio(run.id, file.path)
                  await refreshRuns()
                  await openRun(run.id)
                } catch (error) {
                  setError(error.message)
                }
              },
            }),
          )
      : undefined,
  }
}

/** Back to the drop zone, with nothing selected. */
function newTranscript() {
  closeAside()
  closeModal()
  viewing = null
  runId = null
  selected = null
  chosen = null
  current = null
  els.submit.disabled = true
  setError(null)
  show(els.result, false)
  player?.destroy()
  player = null
  els.audio.hidden = true
  rail?.setActive(null)
  setState('waiting')
  setTitleProgress('')
}

// --- startup -----------------------------------------------------------

// Asked when the box is ticked, which is the user gesture the browser requires.
// Unticking it again is honoured immediately; a denial unticks it, because a
// checked box that cannot do anything is a lie.
els.notify.addEventListener('change', async () => {
  if (!els.notify.checked) return
  if (!(await requestNotifications())) {
    els.notify.checked = false
    setError('Windows notifications are blocked for this site. Allow them in the browser to use this.')
  }
})

let engines = []

/** Put the saved defaults into the form. What "global settings" means here. */
function applySettings(settings) {
  if (!settings) return
  learnEnabled = settings.learnFromCorrections !== false
  els.language.value = settings.language ?? ''
  els.task.value = settings.task ?? 'transcribe'
  els.diarize.checked = Boolean(settings.diarize)
  els.merge.checked = settings.merge !== false
  els.notify.checked = Boolean(settings.notify)
  if (settings.model && [...els.model.options].some((option) => option.value === settings.model)) {
    els.model.value = settings.model
  }
}

els.browse.addEventListener('click', () =>
  openModal(filePicker({ onPick: chooseLocal, start: chosen?.path })),
)

async function init() {
  // Before anything else: the field starts at whatever the shader defaults to,
  // which is the top of its range. Left alone, an idle page drifts at working
  // speed until the first file arrives and corrects it.
  setState('waiting')
  show(els.notifyField, notificationsSupported())

  rail = mountRail({
    onNew: newTranscript,
    onOpenRun: openRun,
    onDeleteRuns: async (ids) => {
      // One at a time: the endpoint deletes one run, and a partial failure
      // should leave the ones that worked deleted rather than pretending none
      // of it happened.
      for (const id of ids) await deleteRun(id).catch(() => {})
      // Whatever is on screen may have just been deleted -- including a run
      // that was never opened from the rail, which is why this asks `runId`.
      if (runId && ids.includes(runId)) {
        closeAside()
        viewing = null
        runId = null
        show(els.result, false)
        setState(selected || chosen ? 'armed' : 'waiting')
      }
      await refreshRuns()
    },
    onSettings: () =>
      openModal(
        settingsModal({
          models: engines,
          onSaved: async (settings) => {
            applySettings(settings)
            await refreshRuns()
          },
        }),
      ),
  })

  canBackground = await hasJobs()
  canBrowse = await hasLocalFiles()
  show(els.browseRow, canBrowse)
  await refreshRuns()

  // A job may already be running from before this page was loaded.
  if (canBackground) await reattach().catch(() => {})

  try {
    const [health, models] = await Promise.all([getHealth(), getModels()])
    engines = models
    els.model.replaceChildren(
      ...models.map((id) => Object.assign(document.createElement('option'), { value: id, textContent: id })),
    )
    const npu = health.engine?.npu_available
    els.status.textContent = npu ? 'NPU ready' : `${health.status} · CPU/remote`
    els.status.className = `badge${npu ? '' : ' badge--warn'}`
  } catch (error) {
    els.status.textContent = 'server unreachable'
    els.status.className = 'badge badge--warn'
    setError(error.message)
  }

  // After the models are listed, so a saved model choice has something to match.
  try {
    applySettings((await getSettings()).settings)
  } catch {
    // No settings service: the form keeps the markup's defaults.
  }
}

init()
