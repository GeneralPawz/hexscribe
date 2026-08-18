/**
 * Who this speaker is.
 *
 * Diarization answers "these utterances are one person". It cannot answer who,
 * and nothing in the audio ever will — a name comes from a person, once. The
 * point of typing it here rather than editing labels row by row is that the name
 * is stored against the *voice print*, so the next recording of the same person
 * is recognised without being told again.
 *
 * The panel is honest about how well that works. It shows the distance behind a
 * recognition, and it says plainly when a speaker has no print to remember —
 * one created by hand in the transcript has no voice behind it, so naming it
 * renames it here and nothing more.
 */

import { enrollVoice, forgetVoice, getVoices } from './api.js'
import { button, field, note, row, stat } from './aside.js'
import { clock } from './dom.js'

/**
 * @param {object} options
 * @param {string} options.speaker current label, e.g. `SPEAKER_00` or `Mara`
 * @param {object} options.transcript the transcript on screen
 * @param {(from: string, to: string) => void} options.onRename applies the new
 *   name to every utterance of this speaker
 * @param {() => void} options.onChanged re-render after the library changed
 */
export function speakerPanel({ speaker, transcript, onRename, onChanged }) {
  return {
    title: 'Speaker',
    mount(body) {
      // The panel outlives its own rename: after saving, the speaker it is about
      // is called something else, and a second save must rename *from* the new
      // name rather than from the one the panel opened with.
      let known = speaker
      const segments = transcript.segments.filter((segment) => segment.speaker === speaker)
      const seconds = segments.reduce((total, segment) => total + (segment.end - segment.start), 0)
      const voice = transcript.voices?.find((entry) => entry.speaker === speaker)

      // An editable dropdown, not a plain field. The names that matter are the
      // ones already in the voice library, and retyping one -- "mara", "Mara " --
      // does not fail, it quietly creates a *second* person and splits the
      // evidence for them across two prints. Picking the existing name is how
      // you say "this is the same person", and enrolling then blends them.
      //
      // `<input list>` rather than a custom widget: a dropdown that still takes
      // free text, with the keyboard behaviour already correct.
      const name = document.createElement('input')
      name.type = 'text'
      name.value = speaker
      name.className = 'aside__input'
      name.setAttribute('aria-label', 'Speaker name')
      name.setAttribute('autocomplete', 'off')

      const options = document.createElement('datalist')
      options.id = `voices-${Math.random().toString(36).slice(2)}`
      name.setAttribute('list', options.id)

      const remember = document.createElement('input')
      remember.type = 'checkbox'
      remember.checked = Boolean(voice)
      remember.disabled = !voice
      const rememberField = field('Remember this voice', remember)
      rememberField.classList.add('aside__field--inline')

      // What saving would actually do. Otherwise the difference between adding
      // to somebody and inventing a near-duplicate of them is invisible: both
      // look like typing a name and pressing Save.
      const effect = note('')
      effect.hidden = true

      body.append(field('Name', name), options, rememberField, effect)

      let library = []
      let live = true

      function describeEffect() {
        const wanted = name.value.trim()
        const match = library.find((entry) => entry.name === wanted)
        if (!voice || !remember.checked || !wanted) {
          effect.hidden = true
          return
        }
        effect.textContent = match
          ? `Adds this voice to ${match.name}, who already has ${clock(match.seconds)} ` +
            `across ${match.recordings} recording${match.recordings === 1 ? '' : 's'}.`
          : `Remembers ${wanted} as a new voice.`
        effect.className = 'aside__note'
        effect.hidden = false
      }

      name.addEventListener('input', describeEffect)
      remember.addEventListener('change', describeEffect)

      getVoices()
        .then((voices) => {
          if (!live) return
          library = voices ?? []
          options.replaceChildren(
            ...library.map((entry) => {
              const option = document.createElement('option')
              option.value = entry.name
              // Shown beside the name in the dropdown, so choosing between two
              // similar ones is done on evidence rather than on spelling.
              option.label =
                `${entry.recordings} recording${entry.recordings === 1 ? '' : 's'} · ${clock(entry.seconds)}`
              return option
            }),
          )
          describeEffect()
        })
        .catch(() => {
          // No voice library on this server. The field stays what it was before
          // — a plain one — rather than a dropdown that never opens.
        })

      body.append(
        note(
          voice
            ? 'The name is stored against this voice, so the next recording of the same person is recognised automatically.'
            : 'This speaker was created by hand, so there is no voice to remember. Renaming applies to this transcript only.',
          voice ? '' : 'muted',
        ),
      )

      const status = note('')
      status.hidden = true

      const save = button('Save', {
        primary: true,
        onClick: async () => {
          const wanted = name.value.trim()
          if (!wanted) {
            show('A speaker needs a name.', 'warn')
            return
          }
          save.disabled = true
          try {
            if (voice && remember.checked) {
              await enrollVoice({ name: wanted, embedding: voice.embedding, seconds: voice.seconds })
            }
            if (wanted !== known) onRename(known, wanted)
            known = wanted
            show(
              voice && remember.checked ? `Saved. ${wanted} will be recognised next time.` : 'Renamed.',
              'ok',
            )
            onChanged?.()
          } catch (error) {
            show(error.message, 'warn')
          } finally {
            save.disabled = false
          }
        },
      })

      const forget = button('Forget this voice', {
        onClick: async () => {
          forget.disabled = true
          try {
            const { forgotten } = await forgetVoice(name.value.trim() || known)
            show(forgotten ? 'Forgotten. The name will not come back on its own.' : 'Nothing stored under that name.', 'ok')
            onChanged?.()
          } catch (error) {
            show(error.message, 'warn')
          } finally {
            forget.disabled = false
          }
        },
      })

      body.append(row(save, forget), status)

      const facts = document.createElement('div')
      facts.className = 'aside__stats'
      facts.append(
        stat('Utterances', String(segments.length)),
        stat('Speaking time', clock(seconds)),
      )
      if (voice?.matched) {
        facts.append(stat('Recognised as', voice.matched.name))
        // The number behind the guess, because "recognised" without a distance
        // is a claim the reader cannot check. Under ~0.5 is the same person on
        // the recordings this was measured against.
        facts.append(stat('Confidence', `${voice.matched.distance.toFixed(2)} distance`))
      }
      body.append(facts)

      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save.click()
      })

      return () => {
        live = false
      }

      function show(message, tone) {
        status.textContent = message
        status.className = `aside__note${tone ? ` aside__note--${tone}` : ''}`
        status.hidden = false
      }
    },
  }
}
