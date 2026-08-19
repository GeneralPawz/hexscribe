/** Rendering a transcript into the page, and getting it back out again. */

import { $, clock } from './dom.js'
import { at } from './annotations.js'

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

/**
 * A section heading, inside the row it starts at.
 *
 * Inside rather than between: `markActive`, the jump-to-row helpers and the
 * selection all index `list.children` by utterance position, and an extra `li`
 * for every heading would put each of them one row out — silently, and only in
 * transcripts that had been marked up.
 */
function renderSection(item, { section, drafting, start, onCommit, onMenu }) {
  const header = document.createElement('header')
  header.className = 'section'

  if (drafting) {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'section__input'
    input.value = section?.title ?? ''
    input.placeholder = 'Name this section'
    input.setAttribute('aria-label', 'Section name')

    let done = false
    // The same bargain as every other editor on this page: Enter commits,
    // Escape puts it back, clicking away keeps what was typed. An empty name
    // is a cancelled section rather than a section called nothing.
    const finish = (value) => {
      if (done) return
      done = true
      onCommit(start, value === null ? null : value.trim())
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(input.value)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
      }
    })
    input.addEventListener('blur', () => finish(input.value))
    input.addEventListener('click', (event) => event.stopPropagation())
    header.append(input)
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
    item.append(header)
    return
  }

  const title = document.createElement('span')
  title.className = 'section__title'
  title.textContent = section.title

  const time = document.createElement('span')
  time.className = 'section__time'
  time.textContent = clock(section.start)

  header.append(title, time)
  header.addEventListener('dblclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onMenu?.(section, event, 'rename')
  })
  header.addEventListener('contextmenu', (event) => {
    if (event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    onMenu?.(section, event)
  })
  item.append(header)
}

export function renderSegments(list, transcript, onSeek, actions = {}) {
  const colours = speakerColours(transcript)
  const {
    onContext, onSelect, onEdit, onBeginEdit, onSpeaker, onSpeakerMenu,
    onOpen, onSectionCommit, onSectionMenu, onInsertSection,
    sections = [], marks = new Map(), draftSection = null,
    // Which rows a filter allows, or null for all of them. The rows that are
    // out stay in the list and are hidden, so every index-based helper --
    // `markActive`, the jump targets, the selection -- still counts the same
    // rows as the transcript does.
    shown = null,
    selected = new Set(), editing = null,
  } = actions
  const allowed = shown ? new Set(shown) : null
  // Anchored by time, so a section stays on the sentence it was put on even
  // after the rows above it are merged and renumbered.
  const sectionAt = new Map(sections.map((section) => [at(section.start), section]))
  list.replaceChildren(
    // Keyed by array position, never by a field on the segment: the server sends
    // OpenAI's `verbose_json`, whose segments carry `id`, while the editing
    // operations renumber `index`. Reading either one here made every merge
    // button silently vanish (`undefined < length - 1` is false).
    ...transcript.segments.map((segment, position) => {
      const item = document.createElement('li')
      const anchor = at(segment.start)
      const section = sectionAt.get(anchor)
      const drafting = draftSection !== null && at(draftSection) === anchor
      if (section || drafting) {
        item.classList.add('has-section')
        renderSection(item, {
          section,
          drafting,
          start: segment.start,
          onCommit: onSectionCommit,
          onMenu: onSectionMenu,
        })
      }

      // A section starts between two lines, so the way to start one is on the
      // line between them. It appears on hover rather than sitting there: a
      // transcript with a button on every row is a control panel, and this is
      // meant to be read.
      if (onInsertSection && !section && !drafting) {
        const insert = document.createElement('button')
        insert.type = 'button'
        insert.className = 'insert'
        insert.title = 'Start a section here'
        insert.setAttribute('aria-label', `Start a section at ${clock(segment.start)}`)
        insert.textContent = '+'
        insert.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          onInsertSection(position)
        })
        item.append(insert)
      }

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

      if (allowed && !allowed.has(position)) item.hidden = true
      if (selected.has(position)) item.classList.add('is-selected')

      // A comment or a tag on a line is invisible until you open it, which
      // makes marking up an hour feel like it did nothing. These are the only
      // marks the transcript carries, and they are small on purpose.
      const mark = marks.get(position)
      if (mark) {
        const badge = document.createElement('span')
        badge.className = 'mark'
        badge.textContent = [mark.noted ? '✎' : '', mark.tagged ? '#' : ''].join('')
        badge.title = [mark.noted ? 'has a comment' : '', mark.tagged ? 'tagged' : '']
          .filter(Boolean)
          .join(' \u00b7 ')
        item.append(badge)
        item.classList.add('is-marked')
      }

      if (onSelect || onOpen) {
        item.addEventListener('click', (event) => {
          // Ctrl/Cmd+click builds a selection.
          if (event.ctrlKey || event.metaKey) {
            if (!onSelect) return
            event.preventDefault()
            onSelect(position, event)
            return
          }
          if (!onOpen) return
          // A plain click opens the utterance -- but not when it was really a
          // click on something with its own job, and not when it finished a
          // drag across the text, because selecting a quotation to copy is a
          // more common thing to do than annotating, and losing it would be a
          // worse thing to happen.
          if (event.target.closest('button, input, textarea, a, .speaker, .section')) return
          if (String(window.getSelection?.() ?? '').length) return
          onOpen(position)
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
  // The summary moved into the aside: it is read once and then sits above the
  // document forever, and it is a fact about the run rather than part of it.
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
