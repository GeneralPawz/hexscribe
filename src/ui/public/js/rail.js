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
 */
export function mountRail({ onNew, onOpenRun, onSettings, onDeleteRuns }) {
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

  return {
    /** @param {Array<object>} runs newest first, as the server returns them */
    setRuns(runs) {
      count.textContent = runs.length ? String(runs.length) : ''
      list.replaceChildren(
        ...runs.map((run) => {
          const item = document.createElement('li')
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

          const meta = document.createElement('span')
          meta.className = 'rail__run-meta'
          meta.textContent =
            run.status === 'failed'
              ? 'failed'
              : run.status === 'interrupted'
                ? 'interrupted · can resume'
                : run.status === 'running'
                  ? 'running…'
                  : `${clock(run.audio_seconds)} · ${run.segments} utt${run.has_audio ? ' · ♪' : ''}`

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
          item.append(button)
          return item
        }),
      )
      if (!runs.length) {
        const empty = document.createElement('li')
        empty.className = 'rail__empty'
        empty.textContent = 'Nothing yet'
        list.append(empty)
      }
      // A run that has been deleted cannot stay selected.
      const alive = new Set(runs.map((run) => run.id))
      for (const id of [...picked]) if (!alive.has(id)) picked.delete(id)
      renderSelection()
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
