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

/**
 * @param source a `File` the user just dropped, or a URL to play from the
 *   server — a stored run has no File, only a recording the server can stream.
 */
export function createPlayer(audio, source) {
  // Only a blob URL needs revoking; a server URL was never ours to release.
  const owned = typeof source !== 'string'
  const url = owned ? URL.createObjectURL(source) : source
  let revoked = false

  audio.src = url
  audio.hidden = false

  const revoke = () => {
    if (revoked || !owned) return
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
    /** Carry on from wherever the head is. */
    play() {
      audio.play().catch(() => {})
    },
    pause() {
      audio.pause()
    },
    /**
     * Stop rather than pause: back to where the thing you were listening to
     * begins. Pausing keeps your place; stopping is for when you want to hear
     * it again from the top, which for a transcript is a line.
     */
    stop(seconds = 0) {
      audio.pause()
      audio.currentTime = Math.max(0, seconds)
    },
    /**
     * How fast, between a quarter speed and five times.
     *
     * `preservesPitch` is what makes 0.6 usable on speech: without it a slowed
     * voice drops an octave and becomes harder to make out rather than easier,
     * which is the opposite of why anybody reaches for the control.
     */
    setRate(value) {
      const wanted = Math.min(5, Math.max(0.25, Number(value) || 1))
      audio.preservesPitch = true
      audio.playbackRate = wanted
      return wanted
    },
    rate() {
      return audio.playbackRate
    },
    at() {
      return audio.currentTime
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
