/**
 * The left rail.
 *
 * Collapsed it is a column of icons; hovering or tabbing into it slides out the
 * labels. It overlays rather than pushing the page, because a layout that
 * reflows every time the pointer crosses it is a layout that fidgets.
 *
 * It carries the application's name — the main pane is for the transcript, and a
 * title bar repeating "hexscribe" above every document was decoration. What
 * belongs here is what is true across the whole app rather than about the thing
 * on screen: past runs, settings, and whatever comes next.
 *
 * Jobs are listed from the database, so the list survives a restart. A run in
 * this list is a *finished* thing; a job still running is the one in the main
 * pane with the field behind it.
 */

import { clock, humanSize } from './dom.js'
import { openMenu } from './menu.js'

const ICONS = {
  new: '✚',
  jobs: '☰',
  settings: '⚙',
}

/**
 * @param {object} options
 * @param {() => void} options.onNew
 * @param {(id: string) => void} options.onOpenRun
 * @param {() => void} options.onSettings
 * @param {(ids: string[]) => Promise<void>} options.onDeleteRuns
 * @param {(id: string, name: string) => Promise<void>} options.onRenameRun
 */
export function mountRail({ onNew, onOpenRun, onSettings, onDeleteRuns, onRenameRun }) {
  const rail = document.querySelector('#rail')
  const list = rail.querySelector('#rail-runs')
  const toggle = rail.querySelector('#rail-jobs-toggle')
  const count = rail.querySelector('#rail-jobs-count')

  rail.querySelector('#rail-new').addEventListener('click', onNew)
  rail.querySelector('#rail-settings').addEventListener('click', onSettings)

  let expanded = true
  const applyExpanded = () => {
    toggle.setAttribute('aria-expanded', String(expanded))
    list.hidden = !expanded
  }
  toggle.addEventListener('click', () => {
    expanded = !expanded
    applyExpanded()
  })
  applyExpanded()

  let active = null
  /**
   * Runs picked with Ctrl+click, for deleting several at once.
   *
   * The same gesture the transcript uses to select utterances, because it is the
   * same idea and learning it twice would be silly. A plain click still opens a
   * run -- selecting is the deliberate variant, not the default.
   */
  const picked = new Set()
  /** The last list the server gave us, so the rail can repaint itself. */
  let listed = []
  /** The run whose name is being typed over, if any. */
  let renaming = null
  const bar = rail.querySelector('#rail-selection')
  const selectedLabel = bar.querySelector('#rail-selected-count')
  const remove = bar.querySelector('#rail-delete')
  const clear = bar.querySelector('#rail-clear')

  function renderSelection() {
    bar.hidden = picked.size === 0
    selectedLabel.textContent = `${picked.size} selected`
    remove.textContent = picked.size > 1 ? `Delete ${picked.size}` : 'Delete'
    remove.dataset.armed = ''
    remove.classList.remove('tool--danger')
    for (const button of list.querySelectorAll('.rail__run')) {
      button.classList.toggle('is-picked', picked.has(button.dataset.id))
    }
  }

  remove.addEventListener('click', async () => {
    if (remove.dataset.armed !== 'yes') {
      // Two clicks, because this deletes transcripts that cost NPU time to make
      // and there is no undo for it.
      remove.dataset.armed = 'yes'
      remove.textContent = `Really delete ${picked.size}?`
      remove.classList.add('tool--danger')
      return
    }
    remove.disabled = true
    try {
      await onDeleteRuns([...picked])
      picked.clear()
    } finally {
      remove.disabled = false
      renderSelection()
    }
  })

  clear.addEventListener('click', () => {
    picked.clear()
    renderSelection()
  })

  /** What a row says under its name. */
  function describeStatus(run) {
    if (run.status === 'failed') return 'failed'
    if (run.status === 'interrupted') return 'interrupted · can resume'
    if (run.status === 'running') return 'running…'
    return `${clock(run.audio_seconds)} · ${run.segments} utt${run.has_audio ? ' · ♪' : ''}`
  }

  /**
   * Type over a run's name in place.
   *
   * The same bargain as correcting an utterance -- Enter commits, Escape
   * cancels, clicking away commits -- because it is the same gesture, and a
   * second set of rules for it would be one more thing to remember for no
   * reason. Only the label changes: the file it was made from, and the path a
   * disk run still plays from, are facts about the recording.
   */
  function renameEditor(run) {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'rail__rename'
    input.value = run.name
    input.setAttribute('aria-label', 'Rename this run')

    let done = false
    const finish = async (value) => {
      if (done) return
      done = true
      renaming = null
      const wanted = value?.trim()
      // An empty field is a cancelled edit, not a run called nothing.
      if (!wanted || wanted === run.name) {
        paint()
        return
      }
      await onRenameRun?.(run.id, wanted)
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void finish(input.value)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation() // cancelling the edit is all this press does
        void finish(null)
      }
    })
    input.addEventListener('blur', () => void finish(input.value))
    // A click in the field must not reach the row underneath and open the run.
    input.addEventListener('click', (event) => event.stopPropagation())

    queueMicrotask(() => {
      input.focus()
      // The whole name selected: renaming usually means replacing it, and the
      // filename it starts as is rarely something to keep half of.
      input.select()
    })
    return input
  }

  /**
   * What right-clicking one run offers.
   *
   * One run, and it says which -- the heading is its name. The bar above is for
   * several at once; this is the menu for the row under the pointer, and the
   * two must not be mistaken for each other, because both of them delete.
   */
  function openRunMenu(run, event) {
    const short = run.name.length > 34 ? `${run.name.slice(0, 33)}…` : run.name
    // Deleting a run that is still decoding would take the row and leave the
    // NPU working on it for the next hour, with nowhere to put the result.
    // Stopping a job is a thing this app cannot yet do, so the menu says that
    // rather than offering a delete that only half happens. Renaming is fine:
    // the name is the one thing about a run that is nobody's but the reader's.
    const running = run.status === 'running'
    openMenu(event.clientX, event.clientY, [
      { heading: short },
      { label: 'Open', onSelect: () => onOpenRun(run.id) },
      {
        label: 'Rename',
        disabled: !onRenameRun,
        onSelect: () => {
          renaming = run.id
          paint()
        },
      },
      {
        label: running ? 'Delete — still running' : 'Delete',
        disabled: running,
        onSelect: () =>
          // A second menu rather than an immediate delete: this throws away a
          // transcript that cost NPU time to make and there is no undo. It is
          // the same two-press bargain the selection bar makes, and it names
          // the run, so the question is about something rather than nothing.
          openMenu(event.clientX, event.clientY, [
            { heading: `Delete ${short}?` },
            { label: 'Delete it', onSelect: () => void onDeleteRuns([run.id]) },
            { label: 'Keep it' },
          ]),
      },
    ])
  }

  function paint() {
    count.textContent = listed.length ? String(listed.length) : ''
    list.replaceChildren(
      ...listed.map((run) => {
        const item = document.createElement('li')
        const meta = document.createElement('span')
        meta.className = 'rail__run-meta'
        meta.textContent = describeStatus(run)

        if (run.id === renaming) {
          // Not a button while it is being typed in: a row that opens the run
          // when the pointer lands in its own text field would be its own bug.
          const editing = document.createElement('div')
          editing.className = 'rail__run is-renaming'
          editing.dataset.id = run.id
          editing.append(renameEditor(run), meta)
          item.append(editing)
          return item
        }

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'rail__run'
        button.dataset.id = run.id
        if (run.id === active) button.classList.add('is-active')
        if (run.status === 'failed') button.classList.add('is-failed')
        if (run.status === 'interrupted' || run.status === 'running') {
          button.classList.add('is-unfinished')
        }

        const name = document.createElement('span')
        name.className = 'rail__run-name'
        name.textContent = run.name
        // The full name in a tooltip: the rail is narrow and these are long.
        button.title = `${run.name}\n${new Date(run.created).toLocaleString()}`

        if (picked.has(run.id)) button.classList.add('is-picked')

        button.append(name, meta)
        button.addEventListener('click', (event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            picked.has(run.id) ? picked.delete(run.id) : picked.add(run.id)
            renderSelection()
            return
          }
          onOpenRun(run.id)
        })
        // Reachable from the keyboard too: the menu key fires `contextmenu`.
        button.addEventListener('contextmenu', (event) => {
          if (event.shiftKey) return // the browser's own menu is one press away
          event.preventDefault()
          openRunMenu(run, event)
        })
        // Double-click renames, which is what a person tries first on a name
        // they want to change -- and the menu is there for those who do not.
        button.addEventListener('dblclick', (event) => {
          if (!onRenameRun) return
          event.preventDefault()
          renaming = run.id
          paint()
        })
        item.append(button)
        return item
      }),
    )
    if (!listed.length) {
      const empty = document.createElement('li')
      empty.className = 'rail__empty'
      empty.textContent = 'Nothing yet'
      list.append(empty)
    }
    renderSelection()
  }

  return {
    /** @param {Array<object>} runs newest first, as the server returns them */
    setRuns(runs) {
      listed = runs
      // A run that has been deleted cannot stay selected, or stay in an editor.
      const alive = new Set(runs.map((run) => run.id))
      for (const id of [...picked]) if (!alive.has(id)) picked.delete(id)
      if (renaming && !alive.has(renaming)) renaming = null
      paint()
    },

    /** Highlight which run the main pane is showing. */
    setActive(id) {
      active = id
      for (const button of list.querySelectorAll('.rail__run')) {
        button.classList.toggle('is-active', button.dataset.id === id)
      }
    },

    expand() {
      expanded = true
      applyExpanded()
    },
  }
}

/** Shared by the rail and the run panel, so one run reads the same in both. */
export function describeRun(run) {
  const speed = run.wall_ms > 0 ? (run.audio_seconds / (run.wall_ms / 1000)).toFixed(1) : '?'
  return [
    `${run.segments} utterances`,
    run.speakers ? `${run.speakers} speakers` : null,
    `${clock(run.audio_seconds)} of audio`,
    `${(run.wall_ms / 1000).toFixed(1)} s (${speed}× real time)`,
    run.has_audio ? `${humanSize(run.audio_bytes)} stored` : run.source === 'disk' ? 'plays from disk' : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
