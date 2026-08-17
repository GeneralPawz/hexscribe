/**
 * What to export, and as what.
 *
 * Four buttons in a row said "here are four formats" and nothing else — no way
 * to say "SRT, but without the speaker labels", and no way to name the file. One
 * button that opens this is fewer things on screen and more that can be asked
 * for.
 *
 * The rendering still happens on the server, through the same `/ui/format`
 * endpoint the CLI's renderers back, so SRT exists in exactly one place. What
 * the options do is shape the transcript *before* it is sent: dropping speaker
 * labels is removing a field, not a second rendering mode the server has to know
 * about.
 */

import { formatTranscript } from './api.js'
import { button, field, note, row } from './aside.js'
import { saveFile } from './dom.js'

const FORMATS = [
  { value: 'srt', label: 'SubRip (.srt)', extension: 'srt', mime: 'text/plain' },
  { value: 'vtt', label: 'WebVTT (.vtt)', extension: 'vtt', mime: 'text/vtt' },
  { value: 'text', label: 'Plain text (.txt)', extension: 'txt', mime: 'text/plain' },
  { value: 'json', label: 'JSON (.json)', extension: 'json', mime: 'application/json' },
]

/**
 * @param {object} options
 * @param {object} options.transcript what is on screen, including any edits
 * @param {string} options.baseName the dropped file's name, without extension
 */
export function downloadPanel({ transcript, baseName }) {
  return {
    title: 'Download',
    mount(body) {
      const format = document.createElement('select')
      format.className = 'aside__input'
      for (const entry of FORMATS) {
        format.append(new Option(entry.label, entry.value))
      }
      body.append(field('Format', format))

      const speakers = document.createElement('input')
      speakers.type = 'checkbox'
      speakers.checked = true
      const hasSpeakers = transcript.segments.some((segment) => segment.speaker)
      speakers.disabled = !hasSpeakers
      speakers.checked = hasSpeakers
      const speakerField = field('Include speaker labels', speakers)
      speakerField.classList.add('aside__field--inline')
      body.append(speakerField)
      if (!hasSpeakers) {
        body.append(note('This transcript has no speakers. Tick "Identify speakers" before transcribing.', 'muted'))
      }

      const fileName = document.createElement('input')
      fileName.type = 'text'
      fileName.className = 'aside__input'
      fileName.value = baseName || 'transcript'
      fileName.setAttribute('aria-label', 'File name')
      body.append(field('File name', fileName))

      const status = note('')
      status.hidden = true

      const download = button('Download', {
        primary: true,
        onClick: async () => {
          const chosen = FORMATS.find((entry) => entry.value === format.value)
          download.disabled = true
          try {
            const payload = speakers.checked || !hasSpeakers ? transcript : withoutSpeakers(transcript)
            const text = await formatTranscript(payload, chosen.value)
            const stem = fileName.value.trim() || 'transcript'
            saveFile(text, `${stem}.${chosen.extension}`, chosen.mime)
            status.textContent = `Saved ${stem}.${chosen.extension}`
            status.className = 'aside__note aside__note--ok'
            status.hidden = false
          } catch (error) {
            status.textContent = error.message
            status.className = 'aside__note aside__note--warn'
            status.hidden = false
          } finally {
            download.disabled = false
          }
        },
      })

      body.append(row(download), status)

      fileName.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') download.click()
      })
    },
  }
}

/** The same transcript with the labels dropped, rather than a second renderer. */
function withoutSpeakers(transcript) {
  return {
    ...transcript,
    speakers: undefined,
    segments: transcript.segments.map(({ speaker: _drop, ...rest }) => rest),
  }
}
