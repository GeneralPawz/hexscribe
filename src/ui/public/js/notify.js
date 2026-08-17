/**
 * Telling Windows about a run that takes minutes.
 *
 * An hour of audio is minutes of NPU, and nobody watches a progress indicator
 * for four minutes — they switch to something else. So the page reports through
 * the operating system's own notification centre instead, where it can be seen
 * without the tab being on screen.
 *
 * Two honest limits, both worth knowing:
 *
 * - **The tab must still exist.** Backgrounded, minimised, behind twenty other
 *   windows: all fine. *Closed* is not, because a page that is gone runs no
 *   code. The job itself survives — the server is doing the work and the result
 *   is waiting when the page comes back — but the notification cannot fire.
 *   Making it survive a closed tab needs a service worker, which is a different
 *   piece of machinery for a smaller benefit than it sounds.
 * - **Progress replaces, it does not accumulate.** Every update reuses one tag,
 *   so the notification centre holds one line per run rather than a hundred, and
 *   the updates are silent. Only the finish makes a sound.
 */

const TAG = 'hexscribe-progress'

export function notificationsSupported() {
  return typeof Notification !== 'undefined'
}

export function notificationsAllowed() {
  return notificationsSupported() && Notification.permission === 'granted'
}

/**
 * Ask, if it has not been asked before.
 *
 * Must be called from a user gesture; the caller does that by only asking when
 * the checkbox is ticked. A denial is remembered by the browser and asking
 * again does nothing, so this never nags.
 *
 * @returns {Promise<boolean>} whether notifications may now be shown
 */
export async function requestNotifications() {
  if (!notificationsSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    return (await Notification.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

let live = null
let lastShown = 0

/**
 * How rarely the progress line may be rewritten.
 *
 * A replacement re-inserts the notification at the top of the Action Center, so
 * rewriting it on every percent makes the panel visibly churn — which is what it
 * did, once a second, for four minutes. Windows has a notification type that
 * updates in place without any of that (`toast-windows.ts` sends it, from the
 * server); this is the web API, which has no such thing, so the only remedy is
 * to do it seldom.
 */
const PROGRESS_EVERY_MS = 20_000

/**
 * Move the progress notification along, if it is time.
 *
 * Deliberately *not* closing the old one first. Closing and constructing is
 * what makes it disappear and reappear; constructing with the same tag replaces
 * it in place, which is as close to a quiet update as this API offers.
 */
export function notifyProgress(title, body, { force = false } = {}) {
  if (!notificationsAllowed()) return
  const now = Date.now()
  if (!force && now - lastShown < PROGRESS_EVERY_MS) return
  lastShown = now
  try {
    live = new Notification(title, { body, tag: TAG, silent: true, renotify: false })
    live.onclick = focusHere
  } catch {
    // Some platforms refuse to construct one outside a service worker. The page
    // still works; it just does not get to speak to the notification centre.
  }
}

/** The one that is allowed to make a sound, because it is the one worth hearing. */
export function notifyDone(title, body) {
  if (!notificationsAllowed()) return
  lastShown = 0
  close()
  try {
    live = new Notification(title, { body, tag: TAG, renotify: true })
    live.onclick = focusHere
  } catch {
    // As above.
  }
}

export function clearNotification() {
  close()
}

function close() {
  try {
    live?.close()
  } catch {
    // Already gone.
  }
  live = null
}

function focusHere() {
  window.focus()
  close()
}

/**
 * The taskbar's own progress readout.
 *
 * The document title is what Windows shows when hovering the taskbar button and
 * what the tab strip shows when the tab is not active, so it is the cheapest
 * place a percentage can be seen without any permission at all.
 */
const BASE_TITLE = document.title

export function setTitleProgress(text) {
  document.title = text ? `${text} · ${BASE_TITLE}` : BASE_TITLE
}
