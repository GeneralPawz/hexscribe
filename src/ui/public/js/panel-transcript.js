/**
 * Everything *about* the transcript, in the panel beside it.
 *
 * The card used to carry a line of statistics and two buttons that opened
 * panels — which put "7 segments · 3 speakers · 0:31 of audio · 3.0 s (10.4×
 * real time) · language en" permanently above a document, where it is read
 * once and then occupies a line forever. It is facts about the run, and facts
 * about the run belong where the other facts about the run already are.
 *
 * So the card is clickable and this is what opens: the numbers, who is in it,
 * and how to get it out, as three tabs. What stays on the card is the two
 * things you do *to* the transcript rather than learn about it — undo, and copy
 * — as icons, right-aligned, out of the way of the words.
 */

import { note, row, stat } from './aside.js'
import { clock } from './dom.js'
import { speakerSummary } from './segments.js'
import { summarize } from './transcript.js'

/** `SPEAKER_02` is the wire label; a name somebody gave is already readable. */
const short = (name) => (name.startsWith('SPEAKER_') ? name.replace(/^SPEAKER_0*/, 'S') : name)

/**
 * @param {object} options
 * @param {object} options.transcript
 * @param {number} options.wall seconds the run took
 * @param {string} options.name what to call it
 * @param {object} [options.runPanel] the stored run's panel, when there is one
 * @param {object} options.downloadPanel
 * @param {string} [options.active] which tab to open on
 * @param {(speaker: string) => void} options.onOpenSpeaker
 * @param {() => void} options.onBrowseSpeakers
 */
export function transcriptPanel({
  transcript, wall, name, runPanel, downloadPanel, active, onOpenSpeaker, onBrowseSpeakers,
}) {
  const speakers = speakerSummary(transcript.segments).sort((a, b) => b.seconds - a.seconds)

  return {
    title: name || 'Transcript',
    active,
    tabs: [
      {
        id: 'info',
        label: 'Info',
        mount: (body) => {
          // A stored run knows far more than the transcript does -- when it ran,
          // on what, how fast, what went wrong -- so when there is one, that
          // panel *is* this tab.
          if (runPanel) return runPanel.mount(body)

          const heading = document.createElement('p')
          heading.className = 'aside__name'
          heading.textContent = name || 'This transcript'
          body.append(heading, note(summarize(transcript, wall), 'muted'))
          body.append(
            note(
              'This one is not in the database, so there is nothing more to say about it yet.',
              'muted',
            ),
          )
        },
      },
      {
        id: 'speakers',
        label: `Speakers (${speakers.length})`,
        mount: (body) => {
          if (!speakers.length) {
            body.append(
              note('No speakers in this transcript. Tick "Identify speakers" before transcribing.', 'muted'),
            )
            return
          }

          const list = document.createElement('ul')
          list.className = 'speakers'
          for (const [index, entry] of speakers.entries()) {
            const item = document.createElement('li')
            item.className = 'speakers__row'

            const chip = document.createElement('button')
            chip.type = 'button'
            chip.className = 'speaker'
            chip.dataset.colour = String(index % 6)
            chip.textContent = short(entry.name)
            chip.title = `${entry.name} — who is this?`
            chip.addEventListener('click', () => onOpenSpeaker(entry.name))

            const meta = document.createElement('span')
            meta.className = 'speakers__meta'
            meta.textContent = `${entry.utterances} utterances · ${clock(entry.seconds)}`

            item.append(chip, meta)
            list.append(item)
          }
          body.append(list)

          // Reading them line by line and merging them is the drawer's job:
          // that needs width, and this column is the wrong shape for it.
          const browse = document.createElement('button')
          browse.type = 'button'
          browse.className = 'tool'
          browse.textContent = 'Browse and merge…'
          browse.addEventListener('click', onBrowseSpeakers)
          body.append(row(browse))
        },
      },
      {
        id: 'download',
        label: 'Download',
        mount: (body) => downloadPanel.mount(body),
      },
    ],
  }
}

/** The numbers, for anywhere that wants them without the panel. */
export function transcriptStats(transcript, wall) {
  const audio = transcript.duration ?? 0
  return [
    stat('Utterances', String(transcript.segments.length)),
    stat('Speakers', String(transcript.speakers?.length ?? 0)),
    stat('Audio', clock(audio)),
    stat('Took', `${wall.toFixed(1)} s`),
  ]
}
