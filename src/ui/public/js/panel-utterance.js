/**
 * One line, and what has been made of it.
 *
 * The transcript is what the machine heard. This is where somebody says what it
 * meant: who said it, what it is about, and what they thought while listening.
 * It is also the transport for that stretch of audio, because deciding any of
 * those things means hearing the line again, usually more than once and often
 * slower.
 *
 * Everything here is anchored to when the line was said rather than to which
 * row it is, so merging the paragraph above does not quietly move a comment
 * onto a different sentence.
 *
 * The tag field suggests the vocabulary already in use, and that is the
 * important part: retyping `pricing` as `Pricing` does not fail, it makes a
 * second tag that finds half the evidence. `pricing/discounts` is one tag with
 * a level in it; typing a `/` is the whole of the syntax.
 */

import { field, note, stat } from './aside.js'
import { clock } from './dom.js'
import { icons } from './icons.js'
import { attachSuggest } from './suggest.js'
import { normaliseTag, tagLeaf } from './annotations.js'

/** What the speed control offers, and what it accepts beyond that. */
const RATES = [0.75, 1, 1.25, 1.5, 2]
const RATE_MIN = 0.25
const RATE_MAX = 5

function iconButton(glyph, label, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon'
  button.title = label
  button.setAttribute('aria-label', label)
  button.append(glyph())
  button.addEventListener('click', onClick)
  return button
}

/**
 * @param {object} options
 * @param {object} options.segment the utterance itself
 * @param {string[]} options.speakers every label in this transcript
 * @param {Array<{name: string}>} options.voices the named voices
 * @param {Array<{id: number, body: string, updated: number}>} options.comments
 * @param {string[]} options.tags what it already carries
 * @param {Array<{name: string, uses: number}>} options.library every tag known
 * @param {boolean} options.stored false when the run is not in the database
 * @param {object} options.playback play, pause, stop, replay, rate, setRate
 * @param {(name: string|null) => Promise<void>} options.onSpeaker
 * @param {(body: string, id?: number) => Promise<void>} options.onComment
 * @param {(id: number) => Promise<void>} options.onDeleteComment
 * @param {(tag: string, on: boolean) => Promise<void>} options.onTag
 */
export function utterancePanel({
  segment, speakers, voices, comments, tags, library, stored,
  playback, onSpeaker, onComment, onDeleteComment, onTag,
}) {
  return {
    title: 'Utterance',
    mount(body) {
      const said = document.createElement('p')
      said.className = 'aside__quote'
      said.textContent = segment.text
      body.append(said)

      // --- hearing it -----------------------------------------------------
      const controls = document.createElement('div')
      controls.className = 'transport'
      controls.append(
        iconButton(icons.play, 'Play from here', () => playback.play()),
        iconButton(icons.pause, 'Pause', () => playback.pause()),
        iconButton(icons.stop, 'Stop, and back to the start of the line', () => playback.stop()),
        iconButton(icons.replay, 'Play the line again from its start', () => playback.replay()),
      )

      const rate = document.createElement('select')
      rate.className = 'transport__rate'
      rate.setAttribute('aria-label', 'Playback speed')
      for (const value of RATES) rate.append(new Option(`${value}×`, String(value)))
      rate.append(new Option('Custom…', 'custom'))
      rate.value = RATES.includes(playback.rate()) ? String(playback.rate()) : 'custom'

      // A number as well as the presets: somebody working through a fast talker
      // in a second language wants 0.6, and a list long enough to hold every
      // useful speed is a list nobody can pick from.
      const custom = document.createElement('input')
      custom.type = 'number'
      custom.className = 'transport__custom'
      custom.min = String(RATE_MIN)
      custom.max = String(RATE_MAX)
      custom.step = '0.05'
      custom.value = String(playback.rate())
      custom.setAttribute('aria-label', `Playback speed, ${RATE_MIN} to ${RATE_MAX}`)
      custom.hidden = rate.value !== 'custom'

      rate.addEventListener('change', () => {
        custom.hidden = rate.value !== 'custom'
        if (rate.value === 'custom') {
          custom.focus()
          return
        }
        playback.setRate(Number(rate.value))
      })
      custom.addEventListener('change', () => {
        const wanted = Math.min(RATE_MAX, Math.max(RATE_MIN, Number(custom.value) || 1))
        custom.value = String(wanted)
        playback.setRate(wanted)
      })

      controls.append(rate, custom)
      body.append(controls)

      const facts = document.createElement('div')
      facts.className = 'aside__stats'
      facts.append(
        stat('At', clock(segment.start)),
        stat('Length', `${(segment.end - segment.start).toFixed(1)} s`),
      )
      body.append(facts)

      // --- who said it ----------------------------------------------------
      // Editable here, because this panel is about *this line* and the
      // commonest correction is one line the diarizer put with the wrong
      // person. Every label in the transcript is offered, and every named
      // voice; anything else typed becomes a new speaker.
      const who = document.createElement('input')
      who.type = 'text'
      who.className = 'aside__input'
      who.value = segment.speaker ?? ''
      who.placeholder = 'Nobody yet'
      who.setAttribute('aria-label', 'Speaker')
      who.setAttribute('autocomplete', 'off')

      const commitSpeaker = async (value) => {
        const wanted = value.trim()
        if (wanted === (segment.speaker ?? '')) return
        await onSpeaker(wanted || null)
      }
      attachSuggest({
        input: who,
        names: () => [...new Set([...speakers, ...voices.map((voice) => voice.name)])],
        onPick: (name) => {
          who.value = name
          void commitSpeaker(name)
        },
      })
      who.addEventListener('blur', () => void commitSpeaker(who.value))
      body.append(field('Speaker', who))

      if (!stored) {
        // No run in the database means nowhere to put any of this. Better said
        // once, here, than by a comment box that swallows what is typed into it.
        body.append(
          note(
            'This transcript is not in the database yet, so comments and tags have nowhere to live.',
            'muted',
          ),
        )
        return
      }

      const status = note('')
      status.hidden = true
      const say = (message, tone = 'ok') => {
        status.textContent = message
        status.className = `aside__note aside__note--${tone}`
        status.hidden = false
      }

      // --- the comments ---------------------------------------------------
      // A list, not a box: reading an interview twice produces two thoughts
      // about the same sentence, and the second one used to overwrite the first.
      const thread = document.createElement('div')
      thread.className = 'thread'

      /** The + on the line between two comments -- the transcript's gesture. */
      const adder = () => {
        const line = document.createElement('div')
        line.className = 'thread__line'
        const plus = document.createElement('button')
        plus.type = 'button'
        plus.className = 'insert insert--inline'
        plus.title = 'Add a comment'
        plus.setAttribute('aria-label', 'Add a comment')
        plus.textContent = '+'
        plus.addEventListener('click', () => startWriting(line))
        line.append(plus)
        return line
      }

      const editorIn = (host, { value = '', rows = 3, label, onFinish }) => {
        const editor = document.createElement('textarea')
        editor.className = 'aside__editor'
        editor.rows = rows
        editor.value = value
        editor.setAttribute('aria-label', label)
        host.append(editor)
        queueMicrotask(() => editor.focus())

        let done = false
        const finish = (text) => {
          if (done) return
          done = true
          void onFinish(text)
        }
        editor.addEventListener('blur', () => finish(editor.value))
        editor.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(null)
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            finish(editor.value)
          }
        })
        return editor
      }

      const startWriting = (line) => {
        if (line.querySelector('textarea')) return
        line.querySelector('.insert')?.remove()
        const editor = editorIn(line, {
          rows: 3,
          label: 'New comment',
          onFinish: async (text) => {
            const wanted = text?.trim()
            if (!wanted) {
              paintComments()
              return
            }
            try {
              await onComment(wanted)
              say('Saved.')
            } catch (error) {
              say(error.message, 'warn')
            }
            paintComments()
          },
        })
        editor.placeholder = 'What is worth remembering about this line?'
      }

      const commentRow = (comment) => {
        const item = document.createElement('div')
        item.className = 'thread__comment'
        item.dataset.id = String(comment.id)

        const text = document.createElement('p')
        text.className = 'thread__text'
        text.textContent = comment.body
        // Click to edit, as everywhere else on this page.
        text.addEventListener('click', () => {
          text.remove()
          editorIn(item, {
            value: comment.body,
            rows: Math.max(2, Math.ceil(comment.body.length / 46)),
            label: 'Comment',
            onFinish: async (edited) => {
              if (edited === null || edited.trim() === comment.body) {
                paintComments()
                return
              }
              try {
                // An emptied comment is a deleted one: clearing the text is
                // what somebody does before looking for a delete button.
                await onComment(edited.trim(), comment.id)
                say(edited.trim() ? 'Saved.' : 'Comment removed.')
              } catch (error) {
                say(error.message, 'warn')
              }
              paintComments()
            },
          })
        })

        const when = document.createElement('span')
        when.className = 'thread__when'
        when.textContent = new Date(comment.updated).toLocaleString()

        const remove = iconButton(icons.trash, 'Delete this comment', async () => {
          try {
            await onDeleteComment(comment.id)
          } catch (error) {
            say(error.message, 'warn')
          }
          paintComments()
        })
        remove.classList.add('icon--danger')

        const bar = document.createElement('div')
        bar.className = 'thread__bar'
        bar.append(when, remove)

        item.append(text, bar)
        return item
      }

      const paintComments = () => {
        thread.replaceChildren()
        if (!comments.length) {
          const empty = document.createElement('p')
          empty.className = 'aside__note aside__note--muted'
          empty.textContent = 'Nothing written about this line yet.'
          thread.append(empty)
        }
        for (const comment of comments) thread.append(commentRow(comment), adder())
        if (!comments.length) thread.append(adder())
      }

      paintComments()
      body.append(field('Comments', thread))

      // --- the tags -------------------------------------------------------
      const chips = document.createElement('div')
      chips.className = 'aside__tags'

      const paintTags = () => {
        chips.replaceChildren()
        if (!tags.length) {
          const empty = document.createElement('span')
          empty.className = 'aside__note aside__note--muted'
          empty.textContent = 'No tags yet.'
          chips.append(empty)
        }
        for (const tag of tags) {
          const chip = document.createElement('button')
          chip.type = 'button'
          chip.className = 'tag tag--removable'
          // The branch above it in small, the level itself in full: a column of
          // chips reading `pricing/…` down the left is a column you cannot scan.
          if (tag.includes('/')) {
            const branch = document.createElement('span')
            branch.className = 'tag__branch'
            branch.textContent = `${tag.slice(0, tag.lastIndexOf('/'))}/`
            chip.append(branch)
          }
          chip.append(document.createTextNode(tagLeaf(tag)))
          chip.title = `Remove ${tag}`
          chip.dataset.tag = tag
          chip.addEventListener('click', async () => {
            chip.disabled = true
            try {
              await onTag(tag, false)
              tags.splice(tags.indexOf(tag), 1)
              paintTags()
            } catch (error) {
              chip.disabled = false
              say(error.message, 'warn')
            }
          })
          chips.append(chip)
        }
      }
      paintTags()

      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'aside__input'
      input.placeholder = 'Add a tag, or a branch/sublevel'
      input.setAttribute('aria-label', 'Add a tag')
      input.setAttribute('autocomplete', 'off')

      const add = async (value) => {
        const wanted = normaliseTag(value ?? input.value)
        if (!wanted) return
        if (tags.includes(wanted)) {
          input.value = ''
          return
        }
        try {
          await onTag(wanted, true)
          tags.push(wanted)
          tags.sort((a, b) => a.localeCompare(b))
          input.value = ''
          paintTags()
        } catch (error) {
          say(error.message, 'warn')
        }
      }

      body.append(field('Tags', input))
      attachSuggest({
        input,
        names: () => library.map((entry) => entry.name),
        exclude: () => tags,
        onPick: (name) => void add(name),
      })

      body.append(chips, status)
    },
  }
}
