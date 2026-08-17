/**
 * What this run was.
 *
 * Opened alongside a stored transcript, because a transcript on its own does
 * not say when it was made, how long it took, what it was asked to do, or what
 * went wrong along the way — and those are exactly the questions somebody has
 * when they come back to a run a week later.
 *
 * It is also where a recording is disposed of. Storage decisions belong next to
 * the thing being stored: "this one is 10 MB and I have the file on disk
 * anyway" is a judgement about *this* run, not a global setting.
 */

import { deleteRun, detachAudio, resumeRun } from './api.js'
import { button, field, note, row, stat } from './aside.js'
import { clock, humanSize } from './dom.js'

/**
 * @param {object} options
 * @param {object} options.run as the server returned it
 * @param {() => void} options.onChanged the history list needs redrawing
 * @param {() => void} options.onDeleted this run is gone; leave it
 * @param {(start: string) => void} [options.onBrowse] open the file picker
 * @param {(id: string) => void} [options.onResume] an interrupted run was restarted
 */
export function runPanel({ run, onChanged, onDeleted, onBrowse, onResume }) {
  return {
    title: 'Run',
    mount(body) {
      const when = new Date(run.created)
      const speed = run.wall_ms > 0 ? (run.audio_seconds / (run.wall_ms / 1000)).toFixed(1) : '?'

      const name = document.createElement('p')
      name.className = 'aside__name'
      name.textContent = run.name
      name.title = run.path ?? run.name
      body.append(name)

      if (run.status === 'failed') {
        body.append(note(run.error ?? 'This run failed.', 'warn'))
      }
      if (run.status === 'interrupted') {
        body.append(
          note(
            `Interrupted after ${run.segments || (run.transcript?.segments.length ?? 0)} utterances. ` +
              'Everything decoded before that was kept, so it can carry on from there.',
            'warn',
          ),
        )
      }

      const facts = document.createElement('div')
      facts.className = 'aside__stats'
      facts.append(
        stat('When', when.toLocaleString()),
        stat('Audio', clock(run.audio_seconds)),
        stat('Took', `${(run.wall_ms / 1000).toFixed(1)} s`),
        stat('Speed', `${speed}× real time`),
        stat('Utterances', String(run.segments)),
      )
      if (run.speakers) facts.append(stat('Speakers', String(run.speakers)))
      facts.append(
        stat('Engine', `${run.engine ?? '?'} / ${run.model ?? '?'}`),
        stat('Language', run.language ?? 'auto'),
        stat('Task', run.task),
      )
      body.append(facts)

      // --- where the audio is ---
      const storage = document.createElement('div')
      storage.className = 'aside__stats'
      storage.append(
        stat(
          'Audio',
          run.has_audio
            ? `stored · ${humanSize(run.audio_bytes)}`
            : run.source === 'disk'
              ? 'on disk'
              : 'not kept',
        ),
      )
      body.append(storage)

      if (run.source === 'disk' && run.path) {
        const location = document.createElement('p')
        location.className = 'aside__path'
        location.textContent = run.path
        location.title = run.path
        body.append(location)
      }

      const status = note('')
      status.hidden = true
      const say = (message, tone) => {
        status.textContent = message
        status.className = `aside__note${tone ? ` aside__note--${tone}` : ''}`
        status.hidden = false
      }

      const actions = []
      if (run.status === 'interrupted' && onResume) {
        const carryOn = button('Resume', {
          primary: true,
          onClick: async () => {
            carryOn.disabled = true
            try {
              const result = await resumeRun(run.id)
              say(`Carrying on from ${Math.round(result.resumeFrom)}s, keeping ${result.kept} utterances.`, 'ok')
              onResume(run.id)
            } catch (error) {
              say(error.message, 'warn')
              carryOn.disabled = false
            }
          },
        })
        actions.push(carryOn)
      }
      if (run.has_audio) {
        const drop = button('Delete stored audio', {
          onClick: async () => {
            drop.disabled = true
            try {
              await detachAudio(run.id)
              say('Deleted. The transcript is untouched, but timestamps will no longer play.', 'ok')
              onChanged?.()
            } catch (error) {
              say(error.message, 'warn')
              drop.disabled = false
            }
          },
        })
        actions.push(drop)
      }

      if (onBrowse) {
        // The other half of deleting the audio: the recording is probably still
        // on this machine, and pointing at it is cheaper than keeping a copy.
        actions.push(
          button(run.source === 'disk' ? 'Point at another file' : 'Play from a file on disk', {
            onClick: () => onBrowse(run.path ?? undefined),
          }),
        )
      }

      const remove = button('Delete this run', {
        onClick: async () => {
          if (remove.dataset.armed !== 'yes') {
            // Two clicks rather than a confirm dialog: this is destructive but
            // small, and a modal on top of a panel is a lot of ceremony.
            remove.dataset.armed = 'yes'
            remove.textContent = 'Really delete it?'
            remove.classList.add('tool--danger')
            return
          }
          remove.disabled = true
          try {
            await deleteRun(run.id)
            onDeleted?.()
          } catch (error) {
            say(error.message, 'warn')
            remove.disabled = false
          }
        },
      })
      actions.push(remove)

      body.append(row(...actions), status)

      if (run.logs?.length) {
        const logs = document.createElement('div')
        logs.className = 'aside__logs'
        const heading = document.createElement('h3')
        heading.className = 'aside__logs-title'
        heading.textContent = 'Log'
        logs.append(heading)
        for (const entry of run.logs) {
          const line = document.createElement('p')
          line.className = `aside__log aside__log--${entry.level}`
          line.textContent = entry.message
          line.title = new Date(entry.created).toLocaleString()
          logs.append(line)
        }
        body.append(logs)
      }
    },
  }
}
