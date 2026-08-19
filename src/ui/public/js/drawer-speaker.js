/**
 * One speaker, in the right half of the drawer.
 *
 * The left half is the list of who is in this recording; this is what you do
 * about one of them. Two things, so two tabs:
 *
 * **General** — what they are called and what they look like. The name is the
 * one that matters: `SPEAKER_02` is an ordinal ("whoever spoke third in this
 * file"), and giving it a name here writes it through every line of this
 * transcript *and* stores it against the voice print, so the next recording of
 * the same person is recognised without being told again.
 *
 * The face is an emoji and a colour rather than an uploaded picture: it has to
 * be legible in a 20px chip beside a line of text, and at that size a
 * photograph is a smudge. It also costs no upload, no blob, and no decision
 * about what happens to somebody's photograph when the database is deleted.
 *
 * **Audios** — every recording this voice has been heard in, which is the
 * question the voice library exists to answer and which nothing in the app
 * could answer until now.
 */

import { clock } from './dom.js'
import { icons } from './icons.js'
import { attachSuggest } from './suggest.js'

/** Enough to tell people apart at a glance, few enough to pick from. */
const FACES = ['🙂', '🎙️', '🎧', '📝', '👤', '🧑‍💼', '👩‍🔧', '🧔', '👵', '🐈', '⭐', '🌱']
const COLOURS = [0, 1, 2, 3, 4, 5]

/** `SPEAKER_02` is the wire label; a name somebody gave is already readable. */
const short = (name) => (name.startsWith('SPEAKER_') ? name.replace(/^SPEAKER_0*/, 'S') : name)

/**
 * @param {object} options
 * @param {string} options.speaker the label as it stands in this transcript
 * @param {object} [options.voice] the library entry, when this speaker is one
 * @param {object} [options.profile] the print this run produced, if any
 * @param {{utterances: number, seconds: number}} options.summary in this run
 * @param {string[]} options.names every name already in use
 * @param {'general'|'audios'} options.tab
 * @param {Array<object>|null} options.runs where else they were heard; null while loading
 * @param {(tab: string) => void} options.onTab
 * @param {(name: string) => void} options.onRename
 * @param {(emoji: string|null, colour: number|null) => void} options.onFace
 * @param {() => void} options.onRemember
 * @param {(runId: string) => void} options.onOpenRun
 */
export function speakerPane(host, {
  speaker, voice, profile, summary, names, tab, runs, onTab, onRename, onFace, onRemember, onOpenRun,
}) {
  const heading = document.createElement('p')
  heading.className = 'aside__name'
  heading.textContent = speaker

  const tabs = document.createElement('div')
  tabs.className = 'pane__tabs'
  for (const entry of [
    { id: 'general', label: 'General' },
    { id: 'audios', label: runs ? `Audios (${runs.length})` : 'Audios' },
  ]) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `pane__tab${entry.id === tab ? ' is-active' : ''}`
    button.dataset.tab = entry.id
    button.textContent = entry.label
    button.addEventListener('click', () => onTab(entry.id))
    tabs.append(button)
  }

  const panel = document.createElement('div')
  panel.className = 'pane__body'

  host.replaceChildren(heading, tabs, panel)

  if (tab === 'audios') {
    mountAudios(panel, { runs, onOpenRun })
    return
  }
  mountGeneral(panel, { speaker, voice, profile, summary, names, onRename, onFace, onRemember })
}

function mountGeneral(body, { speaker, voice, profile, summary, names, onRename, onFace, onRemember }) {
  // --- the face ---
  const face = document.createElement('div')
  face.className = 'face'
  const preview = document.createElement('span')
  preview.className = 'face__avatar'
  preview.dataset.colour = String(voice?.colour ?? 0)
  preview.textContent = voice?.emoji ?? short(speaker).slice(0, 2)
  face.append(preview)

  const picker = document.createElement('div')
  picker.className = 'face__picker'
  for (const emoji of FACES) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = `face__option${voice?.emoji === emoji ? ' is-active' : ''}`
    option.textContent = emoji
    option.title = `Use ${emoji}`
    option.addEventListener('click', () => onFace(emoji, voice?.colour ?? 0))
    picker.append(option)
  }
  const none = document.createElement('button')
  none.type = 'button'
  none.className = 'face__option face__option--none'
  none.title = 'No emoji'
  none.append(icons.cross())
  none.addEventListener('click', () => onFace(null, voice?.colour ?? null))
  picker.append(none)

  const swatches = document.createElement('div')
  swatches.className = 'face__colours'
  for (const colour of COLOURS) {
    const swatch = document.createElement('button')
    swatch.type = 'button'
    swatch.className = `face__colour${(voice?.colour ?? 0) === colour ? ' is-active' : ''}`
    swatch.dataset.colour = String(colour)
    swatch.title = `Colour ${colour + 1}`
    swatch.setAttribute('aria-label', `Colour ${colour + 1}`)
    swatch.addEventListener('click', () => onFace(voice?.emoji ?? null, colour))
    swatches.append(swatch)
  }

  const facesWrap = document.createElement('div')
  facesWrap.className = 'field'
  const facesLabel = document.createElement('span')
  facesLabel.textContent = voice ? 'Face' : 'Face — needs a name first'
  facesWrap.append(facesLabel, face, picker, swatches)
  if (!voice) {
    picker.setAttribute('inert', '')
    swatches.setAttribute('inert', '')
    facesWrap.classList.add('is-disabled')
  }

  // --- the name ---
  const name = document.createElement('input')
  name.type = 'text'
  name.className = 'aside__input'
  name.value = speaker
  name.setAttribute('aria-label', 'Name')
  name.setAttribute('autocomplete', 'off')

  const commit = () => {
    const wanted = name.value.trim()
    if (!wanted || wanted === speaker) return
    onRename(wanted)
  }
  name.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit()
  })
  name.addEventListener('blur', commit)
  attachSuggest({
    input: name,
    names: () => names,
    onPick: (picked) => {
      name.value = picked
      commit()
    },
  })

  const nameField = document.createElement('div')
  nameField.className = 'field'
  const nameLabel = document.createElement('span')
  nameLabel.textContent = 'Name'
  nameField.append(nameLabel, name)

  body.append(nameField, facesWrap)

  // --- what is known about the voice ---
  const facts = document.createElement('div')
  facts.className = 'aside__stats'
  const stat = (label, value) => {
    const line = document.createElement('div')
    line.className = 'aside__stat'
    const key = document.createElement('span')
    key.textContent = label
    const val = document.createElement('strong')
    val.textContent = value
    line.append(key, val)
    return line
  }
  facts.append(
    stat('In this recording', `${summary.utterances} utterances · ${clock(summary.seconds)}`),
  )
  if (voice) {
    facts.append(
      stat('Voice print', `${clock(voice.seconds)} across ${voice.recordings} recording${voice.recordings === 1 ? '' : 's'}`),
    )
  }
  if (profile?.matched) {
    // The number behind the guess: "recognised" without a distance is a claim
    // the reader cannot check.
    facts.append(stat('Recognised as', `${profile.matched.name} · ${profile.matched.distance.toFixed(2)}`))
  }
  body.append(facts)

  if (!voice && profile?.embedding?.length) {
    const remember = document.createElement('button')
    remember.type = 'button'
    remember.className = 'tool tool--primary'
    remember.textContent = 'Remember this voice'
    remember.addEventListener('click', onRemember)

    const why = document.createElement('p')
    why.className = 'aside__note aside__note--muted'
    why.textContent =
      'Stores the print against this name, so the next recording of the same person is ' +
      'recognised without being told again.'
    body.append(remember, why)
  } else if (!profile?.embedding?.length && !voice) {
    const why = document.createElement('p')
    why.className = 'aside__note aside__note--muted'
    why.textContent =
      'This speaker was made by hand, so there is no voice behind it. Renaming applies to this ' +
      'transcript only.'
    body.append(why)
  }
}

function mountAudios(body, { runs, onOpenRun }) {
  if (!runs) {
    const loading = document.createElement('p')
    loading.className = 'aside__note aside__note--muted'
    loading.textContent = 'Looking…'
    body.append(loading)
    return
  }
  if (!runs.length) {
    const empty = document.createElement('p')
    empty.className = 'aside__note aside__note--muted'
    empty.textContent =
      'Only this one so far. A name is written through the transcript it was given in, so a ' +
      'voice appears here once it has been named or recognised in a recording.'
    body.append(empty)
    return
  }

  const list = document.createElement('ul')
  list.className = 'audios'
  for (const run of runs) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'audios__row'
    button.dataset.id = run.id

    const name = document.createElement('span')
    name.className = 'audios__name'
    name.textContent = run.name

    const meta = document.createElement('span')
    meta.className = 'audios__meta'
    meta.textContent =
      `${run.utterances} utterances · ${clock(run.speaker_seconds)} of them · ` +
      new Date(run.created).toLocaleDateString()

    button.append(name, meta)
    button.addEventListener('click', () => onOpenRun(run.id))
    item.append(button)
    list.append(item)
  }
  body.append(list)
}
