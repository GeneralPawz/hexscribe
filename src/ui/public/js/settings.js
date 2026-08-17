/**
 * Settings: what should be true of every run, not this one.
 *
 * The form above the drop zone answers "what am I about to do"; this answers
 * "what do I normally do". They are the same fields, which is the point —
 * setting a default here changes what the form starts as, and changing the form
 * for one run does not change the default.
 *
 * Stored on the server rather than in `localStorage`, because they are settings
 * about the machine doing the work: whether to keep audio and where the database
 * lives are not opinions a browser profile should hold.
 */

import { clearStoredAudio, getSettings, resetStore, saveSettings } from './api.js'
import { checkField, field, section, stat } from './modal.js'
import { humanSize } from './dom.js'

const LANGUAGES = [
  ['', 'Detect automatically'],
  ['de', 'German'],
  ['en', 'English'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
]

/**
 * @param {object} options
 * @param {string[]} options.models engine names the server reports
 * @param {(settings: object) => void} options.onSaved
 */
export function settingsModal({ models, onSaved }) {
  return {
    title: 'Settings',
    mount(body, close) {
      const status = document.createElement('p')
      status.className = 'modal__note'
      status.textContent = 'Loading…'
      body.append(status)

      let live = true
      const say = (message, tone = '') => {
        status.textContent = message
        status.className = `modal__note${tone ? ` modal__note--${tone}` : ''}`
      }

      getSettings()
        .then(({ settings, stats }) => {
          if (!live) return
          body.replaceChildren()
          build(body, settings, stats)
        })
        .catch((error) => say(error.message, 'warn'))

      function build(root, settings, stats) {
        // --- defaults ---
        const language = document.createElement('select')
        for (const [value, label] of LANGUAGES) language.append(new Option(label, value))
        language.value = settings.language ?? ''

        const model = document.createElement('select')
        for (const id of models.length ? models : ['whisper-1']) model.append(new Option(id, id))
        model.value = models.includes(settings.model) ? settings.model : (models[0] ?? 'whisper-1')

        const task = document.createElement('select')
        task.append(new Option('Transcribe', 'transcribe'), new Option('Translate to English', 'translate'))
        task.value = settings.task ?? 'transcribe'

        const diarize = checkField('Identify speakers', settings.diarize,
          'Costs about a third again on top of the transcription.')
        const merge = checkField('Merge split sentences', settings.merge,
          'Rejoins sentences the decoder cut at a 30-second window boundary.')
        const notify = checkField('Notify me when a run finishes', settings.notify,
          'Windows notifications. The tab has to stay open; the job itself does not need it.')

        root.append(
          section('Defaults for new runs',
            field('Language', language),
            field('Model', model),
            field('Task', task),
            diarize.wrapper, merge.wrapper, notify.wrapper),
        )

        // --- storage ---
        const storeAudio = checkField('Keep a copy of uploaded audio', settings.storeAudio,
          'Re-encoded to Opus, about 10 MB an hour, so a transcript stays playable after the upload is deleted. Files transcribed from disk are never copied.')

        const path = document.createElement('input')
        path.type = 'text'
        path.readOnly = true
        path.value = stats.path
        path.className = 'modal__input modal__input--path'
        path.addEventListener('focus', () => path.select())

        root.append(
          section('Storage',
            storeAudio.wrapper,
            field('Database', path, 'Set `store.path` in cordis.yml to move it. Copy this file to back everything up.'),
            stat('Runs kept', String(stats.runs)),
            stat('Stored recordings', `${stats.audioClips} · ${humanSize(stats.audioBytes)}`),
            stat('Log entries', String(stats.logs)),
            stat('Database size', humanSize(stats.fileBytes))),
        )

        // --- danger zone ---
        const clearAudio = document.createElement('button')
        clearAudio.type = 'button'
        clearAudio.className = 'tool tool--danger'
        clearAudio.textContent = `Delete stored audio (${humanSize(stats.audioBytes)})`
        clearAudio.disabled = stats.audioClips === 0
        clearAudio.addEventListener('click', async () => {
          // One click, because it is recoverable in the way that matters: the
          // transcripts — the expensive part — are untouched.
          clearAudio.disabled = true
          try {
            const result = await clearStoredAudio()
            say(`Deleted ${result.cleared} recordings. The transcripts are untouched.`, 'ok')
            onSaved?.()
          } catch (error) {
            say(error.message, 'warn')
          }
        })

        const confirm = document.createElement('input')
        confirm.type = 'text'
        confirm.className = 'modal__input'
        confirm.placeholder = 'delete everything'

        const reset = document.createElement('button')
        reset.type = 'button'
        reset.className = 'tool tool--danger'
        reset.textContent = 'Delete the whole database'
        reset.disabled = true
        // Typing it out, because this is the one that cannot be undone and a
        // misplaced click should not be enough.
        confirm.addEventListener('input', () => {
          reset.disabled = confirm.value.trim() !== 'delete everything'
        })
        reset.addEventListener('click', async () => {
          reset.disabled = true
          try {
            await resetStore()
            say('Deleted. Every run, transcript, recording and setting is gone.', 'ok')
            onSaved?.()
            close()
          } catch (error) {
            say(error.message, 'warn')
          }
        })

        const danger = section('Danger zone',
          document.createElement('div'),
          clearAudio,
          field('Type "delete everything" to enable', confirm),
          reset)
        danger.classList.add('modal__section--danger')
        danger.querySelector('div').className = 'modal__note'
        danger.querySelector('div').textContent =
          'Deleting audio keeps every transcript. Deleting the database keeps nothing.'
        root.append(danger)

        // --- save ---
        const save = document.createElement('button')
        save.type = 'button'
        save.className = 'tool tool--primary'
        save.textContent = 'Save settings'
        save.addEventListener('click', async () => {
          save.disabled = true
          try {
            const result = await saveSettings({
              language: language.value,
              model: model.value,
              task: task.value,
              diarize: diarize.input.checked,
              merge: merge.input.checked,
              notify: notify.input.checked,
              storeAudio: storeAudio.input.checked,
            })
            say('Saved.', 'ok')
            onSaved?.(result.settings)
          } catch (error) {
            say(error.message, 'warn')
          } finally {
            save.disabled = false
          }
        })

        const actions = document.createElement('div')
        actions.className = 'modal__actions'
        actions.append(save)
        root.append(actions, status)
        say('')
      }

      return () => {
        live = false
      }
    },
  }
}
