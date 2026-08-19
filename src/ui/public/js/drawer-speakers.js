/**
 * Every speaker in this recording, and what each of them said.
 *
 * The same job the right aside used to do, in the space it actually wanted.
 * Deciding whether `S7` and `S11` are one person means listening to both, and
 * doing that in a column narrow enough to sit beside a transcript meant tabbing
 * back and forth between a list and its lines. Here they are side by side.
 *
 * Merging stays where the ticks are, because merging is the thing this list is
 * for: a fragmented hour comes out of diarization as a dozen speakers, and the
 * prints of the merged ones combine into one that describes the person better
 * than any fragment did.
 *
 * The right half is where one of them is *edited* — name, face, and every other
 * recording they have been heard in. Their lines are not listed there: picking
 * a speaker filters the transcript instead, where the lines sit in order with
 * what was said around them.
 */

import { panes } from './drawer.js'
import { speakerSummary } from './segments.js'
import { speakerPane } from './drawer-speaker.js'
import { clock } from './dom.js'

/** `SPEAKER_02` is the wire label; a name somebody gave is already readable. */
const short = (name) => (name.startsWith('SPEAKER_') ? name.replace(/^SPEAKER_0*/, 'S') : name)

/**
 * @param {object} options
 * @param {object} options.transcript
 * @param {string} [options.focus] who the right half is about
 * @param {number} options.matches lines the transcript is filtered to
 * @param {object} options.editing everything `speakerPane` needs for the focused one
 * @param {(speaker: string|null) => void} options.onFocus
 * @param {(names: string[], into: string) => void} options.onMerge
 */
export function speakersTab({ transcript, focus, matches = 0, editing, onFocus, onMerge }) {
  // Longest-speaking first: the real people are at the top and the debris is at
  // the bottom, which is the order you want to merge in.
  const summary = speakerSummary(transcript.segments).sort((a, b) => b.seconds - a.seconds)

  return {
    id: 'speakers',
    label: `Speakers (${summary.length})`,
    mount(body) {
      const { left, right } = panes(body, {
        emptyRight: 'Pick a speaker to name them, give them a face, or see where else they have been heard.',
      })

      if (!summary.length) {
        const empty = document.createElement('p')
        empty.className = 'aside__note aside__note--muted'
        empty.textContent = 'No speakers in this transcript. Tick "Identify speakers" before transcribing.'
        left.append(empty)
        return
      }

      const picked = new Set()
      const colours = new Map(summary.map((entry, index) => [entry.name, index % 6]))

      const list = document.createElement('ul')
      list.className = 'speakers'
      for (const entry of summary) {
        const item = document.createElement('li')
        item.className = `speakers__row${entry.name === focus ? ' is-active' : ''}`

        const tick = document.createElement('input')
        tick.type = 'checkbox'
        tick.className = 'speakers__tick'
        tick.setAttribute('aria-label', `Select ${entry.name}`)
        tick.addEventListener('change', () => {
          tick.checked ? picked.add(entry.name) : picked.delete(entry.name)
          update()
        })

        const pick = () => onFocus(entry.name === focus ? null : entry.name)

        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'speaker'
        chip.dataset.colour = String(editing?.faces?.get(entry.name)?.colour ?? colours.get(entry.name))
        const emoji = editing?.faces?.get(entry.name)?.emoji
        chip.textContent = emoji ? `${emoji} ${short(entry.name)}` : short(entry.name)
        chip.title = `${entry.name} — filter the transcript to them`
        chip.addEventListener('click', pick)

        const meta = document.createElement('button')
        meta.type = 'button'
        meta.className = 'speakers__meta'
        meta.textContent = `${entry.utterances} utterances · ${clock(entry.seconds)}`
        meta.title = 'Filter the transcript to what they said'
        meta.addEventListener('click', pick)

        item.append(tick, chip, meta)
        list.append(item)
      }
      left.append(list)

      const merge = document.createElement('button')
      merge.type = 'button'
      merge.className = 'tool tool--primary'
      merge.disabled = true
      merge.addEventListener('click', () => {
        const names = [...picked]
        if (names.length < 2) return
        // Into whoever spoke longest: the most evidence behind the print, and
        // the label most likely to have been named already.
        const into = summary.find((entry) => picked.has(entry.name))?.name ?? names[0]
        onMerge(names, into)
      })

      const hint = document.createElement('span')
      hint.className = 'speakers__hint'

      function update() {
        merge.disabled = picked.size < 2
        const into = summary.find((entry) => picked.has(entry.name))?.name
        merge.textContent = picked.size > 1 ? `Merge ${picked.size} into ${short(into)}` : 'Merge'
        hint.textContent = picked.size > 1 ? 'their voice prints combine into one' : 'tick two or more'
      }
      update()

      const actions = document.createElement('div')
      actions.className = 'drawer__actions'
      actions.append(merge, hint)
      left.append(actions)

      if (!focus || !editing) return

      speakerPane(right, editing)

      const filtered = document.createElement('p')
      filtered.className = matches ? 'aside__note aside__note--ok' : 'aside__note aside__note--muted'
      filtered.textContent = matches
        ? `The transcript is showing their ${matches} line${matches === 1 ? '' : 's'}.`
        : 'They say nothing in this recording.'
      right.append(filtered)
    },
  }
}
