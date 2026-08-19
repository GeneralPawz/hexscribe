/**
 * One line, and what has been made of it.
 *
 * The transcript is what the machine heard. This is where somebody says what it
 * meant: a comment, and tags that put the line next to every other line about
 * the same thing — including lines in other recordings, which is the only
 * reason a tag beats a note saying the same words.
 *
 * Anchored to when the line was said rather than to which row it is, so
 * merging the paragraph above does not quietly move the comment onto a
 * different sentence.
 *
 * The tag field suggests the vocabulary already in use, and that is the
 * important part: retyping `pricing` as `Pricing` does not fail, it makes a
 * second tag that finds half the evidence. Picking an existing one is how you
 * say "the same thing as before".
 *
 * `pricing/discounts` is one tag with a level in it. Typing a `/` is the whole
 * of the syntax, and the suggestions follow you into the branch.
 */

import { field, note, row, stat } from './aside.js'
import { clock } from './dom.js'
import { attachSuggest } from './suggest.js'
import { normaliseTag, tagLeaf } from './annotations.js'

/**
 * @param {object} options
 * @param {object} options.segment the utterance itself
 * @param {number} options.position its row, for jumping back to it
 * @param {string} options.comment what is already written about it
 * @param {string[]} options.tags what it already carries
 * @param {Array<{name: string, uses: number}>} options.library every tag known
 * @param {boolean} options.stored false when the run is not in the database
 * @param {(body: string) => Promise<void>} options.onComment
 * @param {(tag: string, on: boolean) => Promise<void>} options.onTag
 * @param {() => void} options.onPlay
 */
export function utterancePanel({
  segment, comment, tags, library, stored, onComment, onTag, onPlay,
}) {
  return {
    title: 'Utterance',
    mount(body) {
      const said = document.createElement('p')
      said.className = 'aside__quote'
      said.textContent = segment.text
      body.append(said)

      const when = document.createElement('div')
      when.className = 'aside__stats'
      when.append(
        stat('At', clock(segment.start)),
        stat('Length', `${(segment.end - segment.start).toFixed(1)} s`),
      )
      if (segment.speaker) when.append(stat('Speaker', segment.speaker))
      body.append(when)

      const play = document.createElement('button')
      play.type = 'button'
      play.className = 'tool'
      play.textContent = 'Play this line'
      play.addEventListener('click', onPlay)
      body.append(row(play))

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

      // --- the comment ---
      const editor = document.createElement('textarea')
      editor.className = 'aside__editor'
      editor.rows = 4
      editor.value = comment
      editor.placeholder = 'What is worth remembering about this line?'
      editor.setAttribute('aria-label', 'Comment')
      body.append(field('Comment', editor))

      const status = note('')
      status.hidden = true
      const say = (message, tone = 'ok') => {
        status.textContent = message
        status.className = `aside__note aside__note--${tone}`
        status.hidden = false
      }

      let saved = comment
      const commit = async () => {
        const wanted = editor.value.trim()
        if (wanted === saved) return
        try {
          await onComment(wanted)
          saved = wanted
          // An emptied box is how a comment is removed, so the panel says which
          // of the two just happened rather than "Saved" for both.
          say(wanted ? 'Saved.' : 'Comment removed.')
        } catch (error) {
          say(error.message, 'warn')
        }
      }
      // Committed on blur rather than by a button: this is a scratchpad beside
      // a recording, and reaching for Save after every thought is the thing
      // that stops people writing the thought down.
      editor.addEventListener('blur', commit)
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          void commit()
        }
      })

      // --- the tags ---
      const chips = document.createElement('div')
      chips.className = 'aside__tags'

      const paint = () => {
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
              paint()
            } catch (error) {
              chip.disabled = false
              say(error.message, 'warn')
            }
          })
          chips.append(chip)
        }
      }
      paint()

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
          paint()
        } catch (error) {
          say(error.message, 'warn')
        }
      }

      // Its own list rather than a `<datalist>`: the browser decides when to
      // show that one, matches by prefix only, and keeps offering entries that
      // no longer match. This one narrows as you type.
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
