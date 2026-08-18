/**
 * The shape of a recording, as a strip under the player.
 *
 * An hour of audio is a scrollbar's worth of transcript and a flat grey bar
 * under a play button: nothing about either says where the useful part is. The
 * sections do, once they exist — so they are drawn to scale, which turns "this
 * interview is 79 minutes" into "the pricing question is two thirds of the way
 * in and lasts four minutes".
 *
 * Drawn beside the native player rather than on it. `<audio controls>` renders
 * in the browser's own shadow tree and cannot be styled or overlaid reliably;
 * a strip of its own is honest about being a separate thing, and it can be
 * clicked for something the player does not do — moving the *document* rather
 * than the playhead.
 */

import { clock } from './dom.js'
import { spans } from './annotations.js'

/**
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<{start: number, title: string}>} options.sections
 * @param {number} options.duration seconds; nothing is drawn without one
 * @param {(seconds: number) => void} options.onJump scroll the transcript there
 * @param {(section: object, event: MouseEvent) => void} [options.onMenu]
 */
export function renderTimeline(host, { sections, duration, onJump, onMenu }) {
  host.replaceChildren()
  // No duration means no proportions, and a bar drawn without them would be a
  // decoration that lies about where things are.
  const usable = duration > 0 && sections.length > 0
  host.hidden = !usable
  if (!usable) return

  const bands = spans(sections, duration)
  const percent = (seconds) => `${Math.max(0, Math.min(100, (seconds / duration) * 100))}%`

  for (const [index, band] of bands.entries()) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'timeline__band'
    element.style.left = percent(band.start)
    element.style.width = percent(Math.max(0, band.end - band.start))
    element.dataset.colour = String(index % 6)
    element.dataset.start = String(band.start)
    element.title = `${band.title} · ${clock(band.start)}–${clock(band.end)}`

    const label = document.createElement('span')
    label.className = 'timeline__label'
    label.textContent = band.title
    element.append(label)

    // Click moves the reader, not the playhead: the timestamps already play,
    // and a bar that started audio every time it was touched would make
    // finding your place in a document a noisy thing to do.
    element.addEventListener('click', () => onJump(band.start))
    if (onMenu) {
      element.addEventListener('contextmenu', (event) => {
        if (event.shiftKey) return
        event.preventDefault()
        onMenu(band, event)
      })
    }
    host.append(element)
  }

  const head = document.createElement('div')
  head.className = 'timeline__head'
  head.hidden = true
  host.append(head)
}

/**
 * Move the playhead marker.
 *
 * Called from the player's time updates, so the strip says where you are as
 * well as what is where — without which it is a legend rather than a map.
 */
export function markTime(host, seconds, duration) {
  const head = host.querySelector('.timeline__head')
  if (!head || !(duration > 0)) return
  head.hidden = false
  head.style.left = `${Math.max(0, Math.min(100, (seconds / duration) * 100))}%`

  for (const band of host.querySelectorAll('.timeline__band')) {
    const start = Number(band.dataset.start)
    const next = band.nextElementSibling
    const end = next?.classList.contains('timeline__band') ? Number(next.dataset.start) : duration
    band.classList.toggle('is-playing', seconds >= start && seconds < end)
  }
}
