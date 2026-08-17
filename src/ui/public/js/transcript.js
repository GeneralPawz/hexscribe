/** Rendering a transcript into the page, and getting it back out again. */

import { $, clock } from './dom.js'

/**
 * Colour index for a speaker label, stable within one transcript.
 *
 * Derived from the order speakers appear rather than from the label text, so
 * the first voice is always colour 0 no matter how the diarizer numbered it.
 */
function speakerColours(transcript) {
  const seen = new Map()
  for (const segment of transcript.segments) {
    if (segment.speaker && !seen.has(segment.speaker)) seen.set(segment.speaker, seen.size % 6)
  }
  return seen
}

/**
 * @param onSeek called with a segment's start time; omit to leave the
 *   timestamps as plain text, which is what happens when the audio cannot be
 *   played. A timestamp that looks clickable and is not is worse than one that
 *   does not.
 */
/**
 * One row's text, or an editor for it.
 *
 * Editing is a plain textarea seeded with the text: the point is to fix what
 * the model misheard, and anything richer would invite turning the transcript
 * into something the audio does not say.
 */
function renderText(item, segment, position, editing, onEdit) {
  if (editing !== position || !onEdit) {
    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = segment.text
    item.append(text)
    return text
  }

  const editor = document.createElement('textarea')
  editor.className = 'editor'
  editor.value = segment.text
  editor.rows = Math.max(1, Math.ceil(segment.text.length / 90))
  editor.setAttribute('aria-label', 'Correct this utterance')

  let done = false
  const commit = (text) => {
    if (done) return
    done = true
    onEdit(position, text)
  }

  editor.addEventListener('keydown', (event) => {
    // Enter commits: these are utterances, not paragraphs. Shift+Enter is there
    // for the rare one that wants a line break.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      commit(editor.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation() // cancelling an edit is all this press does
      commit(null)
    }
  })
  editor.addEventListener('blur', () => commit(editor.value))

  item.append(editor)
  queueMicrotask(() => {
    editor.focus()
    editor.setSelectionRange(editor.value.length, editor.value.length)
  })
  return editor
}

export function renderSegments(list, transcript, onSeek, actions = {}) {
  const colours = speakerColours(transcript)
  const {
    onContext, onSelect, onEdit, onBeginEdit, onSpeaker, onSpeakerMenu,
    selected = new Set(), editing = null,
  } = actions
  list.replaceChildren(
    // Keyed by array position, never by a field on the segment: the server sends
    // OpenAI's `verbose_json`, whose segments carry `id`, while the editing
    // operations renumber `index`. Reading either one here made every merge
    // button silently vanish (`undefined < length - 1` is false).
    ...transcript.segments.map((segment, position) => {
      const item = document.createElement('li')
      const time = document.createElement('time')
      time.dateTime = `PT${segment.start}S`
      time.textContent = clock(segment.start)

      if (onSeek) {
        const seek = document.createElement('button')
        seek.type = 'button'
        seek.className = 'seek'
        seek.title = `Play from ${clock(segment.start)}`
        seek.append(time)
        seek.addEventListener('click', () => onSeek(segment.start))
        item.append(seek)
      } else {
        item.append(time)
      }

      if (segment.speaker) {
        // A button when there is somewhere to go: the chip *is* the speaker, so
        // clicking it asks about the person rather than about this utterance.
        const speaker = document.createElement(onSpeaker ? 'button' : 'span')
        speaker.className = 'speaker'
        speaker.dataset.colour = String(colours.get(segment.speaker))
        // "SPEAKER_02" is the wire label and shortens to "S2"; a name the user
        // gave is already the readable form and is shown as it was typed.
        speaker.textContent = segment.speaker.startsWith('SPEAKER_')
          ? segment.speaker.replace(/^SPEAKER_0*/, 'S')
          : segment.speaker
        speaker.title = onSpeaker ? `${segment.speaker} — click for details` : segment.speaker
        if (onSpeaker) {
          speaker.type = 'button'
          speaker.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onSpeaker(position, event)
          })
          // Right-click asks about the speaker rather than about the row, so it
          // gets its own menu instead of the utterance one.
          if (onSpeakerMenu) {
            speaker.addEventListener('contextmenu', (event) => {
              if (event.shiftKey) return
              event.preventDefault()
              event.stopPropagation()
              onSpeakerMenu(segment.speaker, position, event)
            })
          }
        }
        item.append(speaker)
      }

      const text = renderText(item, segment, position, editing, onEdit)

      // Double-click is what a person tries first on a wrong word, so it opens
      // the editor -- the same one the menu's *Edit text* opens. The default
      // action is a word selection that the editor would replace anyway.
      if (onBeginEdit && editing !== position) {
        text.addEventListener('dblclick', (event) => {
          event.preventDefault()
          onBeginEdit(position)
        })
      }

      if (segment.edited) {
        item.classList.add('is-edited')
        item.title = 'Corrected by hand'
      }

      if (selected.has(position)) item.classList.add('is-selected')

      if (onSelect) {
        // Ctrl/Cmd+click builds a selection; a plain click is left alone so the
        // text stays selectable and the timestamps keep working.
        item.addEventListener('click', (event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          onSelect(position, event)
        })
      }

      if (onContext) {
        // Reachable from the keyboard too: the menu key fires `contextmenu`.
        item.tabIndex = 0
        item.addEventListener('contextmenu', (event) => {
          // Shift+right-click still gets the browser's own menu.
          if (event.shiftKey) return
          event.preventDefault()
          onContext(position, event, text)
        })
      }

      return item
    }),
  )
}

export function summarize(transcript, wallSeconds) {
  const audio = transcript.duration ?? 0
  const speed = wallSeconds > 0 ? (audio / wallSeconds).toFixed(1) : '?'
  return [
    `${transcript.segments.length} segments`,
    transcript.speakers?.length ? `${transcript.speakers.length} speakers` : null,
    `${clock(audio)} of audio`,
    `${wallSeconds.toFixed(1)} s (${speed}× real time)`,
    transcript.language ? `language ${transcript.language}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * What was skipped, in words, or nothing at all.
 *
 * Shown next to the summary rather than as an error, because it is not one: the
 * transcript is good, and a sentence of it may be missing. Saying nothing would
 * be the error.
 */
export function damageNote(transcript) {
  const damage = transcript.damage
  if (!damage?.skipped_packets) return ''
  const share = damage.total_packets
    ? ` (${((damage.skipped_packets / damage.total_packets) * 100).toFixed(2)}%)`
    : ''
  return `${damage.skipped_packets} damaged audio ${
    damage.skipped_packets === 1 ? 'packet was' : 'packets were'
  } skipped${share} — a little audio is missing from this transcript.`
}

/** Highlight the segment being spoken, and keep it in view if the list scrolls. */
export function markActive(list, index) {
  const items = list.children
  for (let i = 0; i < items.length; i++) items[i].classList.toggle('is-active', i === index)

  const item = items[index]
  if (!item) return
  const bounds = list.getBoundingClientRect()
  const rect = item.getBoundingClientRect()
  if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

export function mountResult(transcript, wallSeconds, baseName, onSeek, actions) {
  $('#summary').textContent = summarize(transcript, wallSeconds)

  const damage = $('#damage')
  const note = damageNote(transcript)
  damage.textContent = note
  damage.hidden = !note

  renderSegments($('#segments'), transcript, onSeek, actions)

  $('[data-copy]').onclick = async () => {
    await navigator.clipboard.writeText(transcript.text)
    const button = $('[data-copy]')
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = 'Copy text'), 1200)
  }
}
