/**
 * Every speaker in this transcript, and what each of them said.
 *
 * Diarization splits one person more often than it joins two, and the longer the
 * recording the worse it gets — a voice heard across an hour drifts, and a
 * clustering strict enough to keep two people apart is strict enough to cut one
 * person into pieces. A 1.31 h interview came out as 45 speakers before the
 * linkage was fixed, and around a dozen after; the rest is a judgement only
 * somebody who can hear the recording is able to make.
 *
 * So: two tabs. One lists the speakers, ticks several, and merges them. The
 * other lists one speaker's utterances, each clickable — because the way to
 * decide whether `S7` and `S11` are the same person is to hear them, and
 * scrolling an hour-long transcript looking for six scattered lines is not a
 * reasonable way to be asked to do that.
 *
 * Merging is worth more than tidying the page. The prints of the merged
 * speakers are blended into one, weighted by how much speech is behind each,
 * and that combined print is what the next recording is matched against. Six
 * fragments of somebody rejoined by hand describe them better than any one
 * fragment did.
 */

import { enrollVoice } from './api.js'
import { button, note, row } from './aside.js'
import { clock } from './dom.js'
import { speakerSummary, utterancesOf } from './segments.js'

/**
 * @param {object} options
 * @param {object} options.transcript
 * @param {string} [options.focus] speaker whose utterances the second tab shows
 * @param {(names: string[], into: string) => void} options.onMerge
 * @param {(position: number) => void} options.onJump scroll to and play an utterance
 * @param {(speaker: string) => void} options.onOpenSpeaker the identity panel
 * @param {(speaker: string) => void} options.onFocus remember which one is being examined
 */
export function speakersPanel({ transcript, focus, onMerge, onJump, onOpenSpeaker, onFocus }) {
  const summary = speakerSummary(transcript.segments)
  const chosen = focus && summary.some((entry) => entry.name === focus) ? focus : summary[0]?.name

  return {
    title: 'Speakers',
    active: focus ? 'utterances' : 'list',
    tabs: [
      {
        id: 'list',
        label: `Speakers (${summary.length})`,
        mount: (body) => mountList(body, { transcript, summary, onMerge, onOpenSpeaker, onFocus }),
      },
      {
        id: 'utterances',
        label: chosen ? `${short(chosen)} · utterances` : 'Utterances',
        mount: (body) => mountUtterances(body, { transcript, speaker: chosen, onJump }),
      },
    ],
  }
}

/** `SPEAKER_02` is the wire label; a name the user gave is already readable. */
function short(name) {
  return name.startsWith('SPEAKER_') ? name.replace(/^SPEAKER_0*/, 'S') : name
}

function mountList(body, { transcript, summary, onMerge, onOpenSpeaker, onFocus }) {
  if (!summary.length) {
    body.append(note('No speakers in this transcript. Tick "Identify speakers" before transcribing.', 'muted'))
    return
  }

  const picked = new Set()
  const list = document.createElement('ul')
  list.className = 'speakers'

  const colours = new Map(summary.map((entry, index) => [entry.name, index % 6]))
  // Longest-speaking first: on a fragmented transcript the real people are at
  // the top and the debris is at the bottom, which is the order you want to
  // merge in.
  const ordered = [...summary].sort((a, b) => b.seconds - a.seconds)

  for (const entry of ordered) {
    const item = document.createElement('li')
    item.className = 'speakers__row'

    const tick = document.createElement('input')
    tick.type = 'checkbox'
    tick.className = 'speakers__tick'
    tick.setAttribute('aria-label', `Select ${entry.name}`)
    tick.addEventListener('change', () => {
      tick.checked ? picked.add(entry.name) : picked.delete(entry.name)
      update()
    })

    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'speaker'
    chip.dataset.colour = String(colours.get(entry.name))
    chip.textContent = short(entry.name)
    chip.title = `${entry.name} — open`
    chip.addEventListener('click', () => onOpenSpeaker(entry.name))

    const meta = document.createElement('button')
    meta.type = 'button'
    meta.className = 'speakers__meta'
    meta.textContent = `${entry.utterances} utterances · ${clock(entry.seconds)}`
    meta.title = 'Show what they said'
    // The whole row is the way through to the utterances, because that is what
    // somebody is here to do.
    meta.addEventListener('click', () => onFocus(entry.name))

    item.append(tick, chip, meta)
    list.append(item)
  }
  body.append(list)

  const status = note('')
  status.hidden = true

  const merge = button('Merge', {
    primary: true,
    onClick: () => {
      const names = [...picked]
      if (names.length < 2) return
      // Into whoever spoke longest: the most evidence, and the label most likely
      // to already be named.
      const into = ordered.find((entry) => picked.has(entry.name))?.name ?? names[0]
      onMerge(names, into)
    },
  })

  const hint = document.createElement('span')
  hint.className = 'speakers__hint'

  function update() {
    merge.disabled = picked.size < 2
    const into = ordered.find((entry) => picked.has(entry.name))?.name
    merge.textContent = picked.size > 1 ? `Merge ${picked.size} into ${short(into)}` : 'Merge'
    hint.textContent = picked.size > 1 ? 'their voice prints combine into one' : 'tick two or more'
  }
  update()

  body.append(row(merge, hint), status)
}

function mountUtterances(body, { transcript, speaker, onJump }) {
  if (!speaker) {
    body.append(note('Pick a speaker to see what they said.', 'muted'))
    return
  }

  const found = utterancesOf(transcript.segments, speaker)
  const seconds = found.reduce((total, entry) => total + (entry.segment.end - entry.segment.start), 0)

  const heading = document.createElement('p')
  heading.className = 'aside__name'
  heading.textContent = speaker
  body.append(heading, note(`${found.length} utterances · ${clock(seconds)}`, 'muted'))

  const list = document.createElement('ol')
  list.className = 'utterances'
  for (const { position, segment } of found) {
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
    // Play it, and scroll the transcript to it: deciding whether two labels are
    // the same person means hearing them, not reading them.
    jump.addEventListener('click', () => onJump(position))
    item.append(jump)
    list.append(item)
  }
  body.append(list)
}

/**
 * Name a merged speaker and remember the combined print.
 *
 * Offered from the identity panel; kept here because the print it enrols is the
 * one merging produced, and the two belong to the same idea.
 */
export async function rememberSpeaker(transcript, speaker, name) {
  const voice = transcript.voices?.find((entry) => entry.speaker === speaker)
  if (!voice?.embedding?.length) return null
  return enrollVoice({ name, embedding: voice.embedding, seconds: voice.seconds })
}
