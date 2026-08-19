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
 * Tags nest — `pricing/discounts` — and the list is a tree because that is the
 * only way the levels are worth having: clicking `pricing` means everything
 * under it, and clicking the sublevel narrows to exactly that. A level nobody
 * tagged directly is still shown, because the first sublevel somebody invents
 * would otherwise make its own parent unreachable.
 *
 * Picking one **filters the transcript** rather than listing its lines here.
 * The lines belong in the document, in order, with what was said before and
 * after them — that context is most of what makes a line mean anything, and a
 * list in a drawer throws it away. Which leaves this half of the drawer for the
 * vocabulary itself: rename it, merge it by dragging one onto another, forget it.
 */

import { panes } from './drawer.js'
import { tagTree, tagsInRun } from './annotations.js'
import { icons } from './icons.js'

/**
 * @param {object} options
 * @param {{tags: Array<{start: number, tag: string}>}} options.annotations
 * @param {Array<{name: string, uses: number, runs: number}>} options.library
 * @param {string} [options.focus] the tag the transcript is filtered to
 * @param {number} options.matches how many lines that filter is showing
 * @param {(tag: string|null) => void} options.onFocus
 * @param {(tag: string, event: MouseEvent) => void} [options.onMenu]
 * @param {string} [options.renaming] the tag being typed over, if any
 * @param {(from: string, to: string|null) => void} [options.onRename]
 * @param {(from: string, into: string) => void} [options.onMerge]
 */
export function tagsTab({
  annotations, library, focus, renaming, matches = 0, onFocus, onMenu, onRename, onMerge,
}) {
  const here = tagsInRun(annotations.tags)
  const mine = new Set(here.map((entry) => entry.name))
  const elsewhere = library.filter((entry) => !mine.has(entry.name))

  return {
    id: 'tags',
    label: `Tags (${here.length})`,
    mount(body) {
      const { left, right } = panes(body, {
        emptyRight: 'Pick a tag to filter the transcript. Drag one onto another to merge them.',
      })

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
        left.append(branch(tagTree(entries), describe, 0))
      }

      /** One level of the tree, and its own levels under it. */
      function branch(nodes, describe, depth) {
        const list = document.createElement('ul')
        list.className = `taglist${depth ? ' taglist--nested' : ''}`
        for (const entry of nodes) {
          const item = document.createElement('li')

          if (entry.path === renaming) {
            // Typed over in place, under the same rules as every other rename
            // on this page: Enter commits, Escape puts it back, clicking away
            // keeps what was typed.
            const input = document.createElement('input')
            input.type = 'text'
            input.className = 'taglist__input'
            input.value = entry.path
            input.setAttribute('aria-label', `Rename ${entry.path}`)

            let done = false
            const finish = (value) => {
              if (done) return
              done = true
              onRename?.(entry.path, value === null ? null : value.trim())
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
          // A level nobody filed anything at directly is a place rather than a
          // choice somebody made, and it says so by being quieter.
          button.className =
            `tag tag--pick${entry.path === focus ? ' is-active' : ''}${entry.own ? '' : ' tag--branch'}`
          button.dataset.tag = entry.path
          button.textContent = entry.name

          const count = document.createElement('span')
          count.className = 'tag__count'
          count.textContent = describe(entry)
          button.append(count)

          // Dragging one tag onto another merges them: it is the gesture the
          // idea already has -- put this in there. The alternative was typing
          // the target's whole path into a rename box, and for
          // `deeply/nested/tag` that is exactly the typing that produces a
          // near-duplicate instead of a merge.
          if (onMerge && entry.own) {
            button.draggable = true
            button.addEventListener('dragstart', (event) => {
              event.dataTransfer.setData('text/plain', entry.path)
              event.dataTransfer.effectAllowed = 'move'
              button.classList.add('is-dragging')
            })
            button.addEventListener('dragend', () => button.classList.remove('is-dragging'))
          }
          if (onMerge) {
            const wouldTake = (from) =>
              // Not onto itself, and not into its own branch: a tag cannot
              // contain itself, and `a` dropped on `a/b` would try.
              Boolean(from) && from !== entry.path && !entry.path.startsWith(`${from}/`)

            button.addEventListener('dragover', (event) => {
              if (!wouldTake(event.dataTransfer.getData('text/plain'))) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              button.classList.add('is-target')
            })
            button.addEventListener('dragleave', () => button.classList.remove('is-target'))
            button.addEventListener('drop', (event) => {
              event.preventDefault()
              button.classList.remove('is-target')
              const from = event.dataTransfer.getData('text/plain')
              if (wouldTake(from)) onMerge(from, entry.path)
            })
          }

          // Clicking the tag that is already showing puts the whole transcript
          // back: the filter is a state, so the button that set it clears it.
          button.addEventListener('click', () => onFocus(entry.path === focus ? null : entry.path))
          if (onMenu) {
            button.addEventListener('contextmenu', (event) => {
              if (event.shiftKey) return
              event.preventDefault()
              onMenu(entry.path, event)
            })
          }
          item.append(button)
          if (entry.children.length) item.append(branch(entry.children, describe, depth + 1))
          list.append(item)
        }
        return list
      }

      group(
        'In this recording',
        here,
        // What is under this level, which is what clicking it will filter to.
        (entry) => String(entry.total),
        'Nothing tagged yet. Click a line to start.',
      )
      group(
        'Everywhere else',
        elsewhere.map((entry) => ({ name: entry.name, uses: entry.runs })),
        // Runs rather than utterances: what matters about a tag you have not
        // used here is how established it is, not how often it was repeated in
        // one conversation.
        (entry) => `${entry.total} run${entry.total === 1 ? '' : 's'}`,
        'No other tags yet.',
      )

      if (!focus) return

      const heading = document.createElement('p')
      heading.className = 'aside__name'
      heading.textContent = focus

      const filtered = document.createElement('p')
      filtered.className = matches ? 'aside__note aside__note--ok' : 'aside__note aside__note--muted'
      filtered.textContent = matches
        ? `The transcript is showing the ${matches} line${matches === 1 ? '' : 's'} under this tag.`
        : 'Nothing in this recording carries it yet.'

      const actions = document.createElement('div')
      actions.className = 'drawer__actions'

      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'tool'
      clear.textContent = 'Show every line again'
      clear.addEventListener('click', () => onFocus(null))

      const rename = document.createElement('button')
      rename.type = 'button'
      rename.className = 'tool tool--icon'
      rename.append(icons.pencil(), document.createTextNode('Rename'))
      rename.addEventListener('click', () => onRename?.(focus, undefined))

      actions.append(clear, rename)

      const hint = document.createElement('p')
      hint.className = 'aside__note aside__note--muted'
      hint.textContent =
        'Drag a tag onto another to merge them: everything filed under the one you drag moves ' +
        'to the one you drop it on, sublevels included.'

      right.replaceChildren(heading, filtered, actions, hint)
    },
  }
}
