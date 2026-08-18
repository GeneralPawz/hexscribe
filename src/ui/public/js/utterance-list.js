/**
 * A list of utterances you can jump to.
 *
 * The same list answers two different questions — "what did this speaker say"
 * and "where is everything about pricing" — and in both of them the point is
 * the same: reading six scattered lines out of an hour-long transcript means
 * being taken to them, not being told they exist.
 */

import { clock } from './dom.js'

/**
 * @param {Array<{position: number, segment: object}>} entries
 * @param {(position: number) => void} onJump
 * @param {(segment: object) => string} [describe] a second line under the text
 */
export function utteranceList(entries, onJump, describe) {
  const list = document.createElement('ol')
  list.className = 'utterances'

  for (const { position, segment } of entries) {
    const item = document.createElement('li')
    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = 'utterances__row'

    const when = document.createElement('time')
    when.className = 'utterances__time'
    when.dateTime = `PT${segment.start}S`
    when.textContent = clock(segment.start)

    const text = document.createElement('span')
    text.className = 'utterances__text'
    text.textContent = segment.text

    jump.append(when, text)

    const extra = describe?.(segment)
    if (extra) {
      const meta = document.createElement('span')
      meta.className = 'utterances__meta'
      meta.textContent = extra
      jump.append(meta)
    }

    // Play it and scroll the transcript to it: deciding whether a line is the
    // one you remember means hearing it, not reading it again.
    jump.addEventListener('click', () => onJump(position))
    item.append(jump)
    list.append(item)
  }
  return list
}
