/**
 * Playback for the transcript: click a timestamp, hear that moment.
 *
 * The audio never leaves the browser — the file the user dropped is played from
 * an object URL, so nothing is uploaded a second time and nothing is cached on
 * the server. The URL is revoked whenever it is replaced, because a leaked one
 * pins the whole file in memory.
 *
 * A browser cannot necessarily decode everything FFmpeg can (the worker is far
 * more permissive), so failing to play is expected and handled: the player hides
 * itself and the timestamps go back to being plain text rather than pretending
 * to be buttons that do nothing.
 */

/**
 * Index of the segment being spoken at `time`, or -1 before the first.
 *
 * Segments are in order, so this walks until it passes `time`. The small
 * tolerance keeps a click on a timestamp from landing just before its own
 * segment because of float rounding in `currentTime`.
 */
export function activeIndex(segments, time, tolerance = 0.05) {
  let active = -1
  for (let i = 0; i < segments.length; i++) {
    if (time + tolerance < segments[i].start) break
    active = i
  }
  return active
}

export function createPlayer(audio, file) {
  const url = URL.createObjectURL(file)
  let revoked = false

  audio.src = url
  audio.hidden = false

  const revoke = () => {
    if (revoked) return
    revoked = true
    URL.revokeObjectURL(url)
  }

  // The player is created as soon as a file is chosen, so a decode failure can
  // land before anything has asked to hear about it. Record it and replay it.
  let broken = false
  const waiting = []
  audio.addEventListener('error', () => {
    broken = true
    audio.hidden = true
    revoke()
    for (const callback of waiting.splice(0)) callback()
  })

  return {
    seek(seconds) {
      audio.currentTime = Math.max(0, seconds)
      // A click is a user gesture, so this is allowed; a rejection is still
      // possible (autoplay policy, decode failure) and is not worth surfacing.
      audio.play().catch(() => {})
    },
    onTime(callback) {
      audio.addEventListener('timeupdate', () => callback(audio.currentTime))
      audio.addEventListener('seeked', () => callback(audio.currentTime))
    },
    onUnplayable(callback) {
      broken ? callback() : waiting.push(callback)
    },
    destroy() {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.hidden = true
      revoke()
    },
  }
}
