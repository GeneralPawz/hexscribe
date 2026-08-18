/**
 * Tags: what this recording is about, and what everything else is filed under.
 *
 * Two lists rather than one, and the difference is the point. *In this
 * recording* answers "what did we cover"; *everywhere else* is the vocabulary
 * already in use, and having it in front of you is what stops the second
 * interview being tagged `price` when the first one said `pricing` — two tags
 * that each find half the evidence and neither of which is wrong enough to
 * notice.
 *
 * Picking one lists the lines carrying it, on the right, each of them a click
 * from being played.
 */

import { panes } from './drawer.js'
import { rowsWithTag, tagsInRun } from './annotations.js'
import { utteranceList } from './utterance-list.js'
import { clock } from './dom.js'

/**
 * @param {object} options
 * @param {object} options.transcript
 * @param {{tags: Array<{start: number, tag: string}>}} options.annotations
 * @param {Array<{name: string, uses: number, runs: number}>} options.library
 * @param {string} [options.focus] the tag whose lines are shown
 * @param {(tag: string) => void} options.onFocus
 * @param {(position: number) => void} options.onJump
 * @param {(tag: string, event: MouseEvent) => void} [options.onMenu]
 * @param {string} [options.renaming] the tag being typed over, if any
 * @param {(from: string, to: string|null) => void} [options.onRename]
 */
export function tagsTab({
  transcript, annotations, library, focus, renaming, onFocus, onJump, onMenu, onRename,
}) {
  const here = tagsInRun(annotations.tags)
  const mine = new Set(here.map((entry) => entry.name))
  const elsewhere = library.filter((entry) => !mine.has(entry.name))

  return {
    id: 'tags',
    label: `Tags (${here.length})`,
    mount(body) {
      const { left, right } = panes(body, { emptyRight: 'Pick a tag to see where it is.' })

      const group = (title, entries, describe, empty) => {
        const heading = document.createElement('p')
        heading.className = 'drawer__group'
        heading.textContent = title
        left.append(heading)

        if (!entries.length) {
          const nothing = document.createElement('p')
          nothing.className = 'aside__note aside__note--muted'
          nothing.textContent = empty
          left.append(nothing)
          return
        }

        const list = document.createElement('ul')
        list.className = 'taglist'
        for (const entry of entries) {
          const item = document.createElement('li')

          if (entry.name === renaming) {
            // Typed over in place, under the same rules as every other rename
            // on this page: Enter commits, Escape puts it back, clicking away
            // keeps what was typed. Renaming onto a name that already exists
            // merges the two, which is the only way to undo a near-duplicate.
            const input = document.createElement('input')
            input.type = 'text'
            input.className = 'taglist__input'
            input.value = entry.name
            input.setAttribute('aria-label', `Rename ${entry.name}`)

            let done = false
            const finish = (value) => {
              if (done) return
              done = true
              onRename?.(entry.name, value === null ? null : value.trim())
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
            item.append(input)
            list.append(item)
            queueMicrotask(() => {
              input.focus()
              input.select()
            })
            continue
          }

          const button = document.createElement('button')
          button.type = 'button'
          button.className = `tag tag--pick${entry.name === focus ? ' is-active' : ''}`
          button.dataset.tag = entry.name
          button.textContent = entry.name

          const count = document.createElement('span')
          count.className = 'tag__count'
          count.textContent = describe(entry)
          button.append(count)

          button.addEventListener('click', () => onFocus(entry.name))
          if (onMenu) {
            button.addEventListener('contextmenu', (event) => {
              if (event.shiftKey) return
              event.preventDefault()
              onMenu(entry.name, event)
            })
          }
          item.append(button)
          list.append(item)
        }
        left.append(list)
      }

      group(
        'In this recording',
        here,
        (entry) => String(entry.uses),
        'Nothing tagged yet. Click a line to start.',
      )
      group(
        'Everywhere else',
        elsewhere,
        // Runs rather than utterances: what matters about a tag you have not
        // used here is how established it is, not how often it was repeated in
        // one conversation.
        (entry) => `${entry.runs} run${entry.runs === 1 ? '' : 's'}`,
        'No other tags yet.',
      )

      if (!focus) return

      const rows = rowsWithTag(transcript.segments, annotations.tags, focus)
      const entries = rows.map((position) => ({ position, segment: transcript.segments[position] }))
      const seconds = entries.reduce(
        (total, entry) => total + (entry.segment.end - entry.segment.start),
        0,
      )

      const heading = document.createElement('p')
      heading.className = 'aside__name'
      heading.textContent = focus

      const meta = document.createElement('p')
      meta.className = 'aside__note aside__note--muted'
      meta.textContent = entries.length
        ? `${entries.length} utterance${entries.length === 1 ? '' : 's'} here · ${clock(seconds)}`
        : 'Not used in this recording yet.'

      right.replaceChildren(heading, meta)
      if (entries.length) {
        right.append(utteranceList(entries, onJump, (segment) => segment.speaker ?? ''))
      }
    },
  }
}
