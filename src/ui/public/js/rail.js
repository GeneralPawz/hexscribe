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
 */
export function mountRail({ onNew, onOpenRun, onSettings }) {
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
              : `${clock(run.audio_seconds)} · ${run.segments} utt${run.has_audio ? ' · ♪' : ''}`

          button.append(name, meta)
          button.addEventListener('click', () => onOpenRun(run.id))
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
