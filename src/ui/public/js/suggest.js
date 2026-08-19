/**
 * Suggesting a name somebody is halfway through typing.
 *
 * This exists for one failure: retyping a tag slightly differently makes a
 * second tag, and two tags that each hold half the evidence are worse than one
 * tag and a typo. So the list has to be in front of you while you type, and it
 * has to narrow — a list that still shows everything after four characters is a
 * list nobody reads, and the second tag gets made anyway.
 *
 * Three kinds of match, in order of how much they mean:
 *
 *   prefix      `pri` → `pricing`            — you are typing this one
 *   substring   `count` → `pricing/discount` — you remember the middle of it
 *   subsequence `prdis` → `pricing/discount` — you are typing the initials
 *
 * The subsequence is where "fuzzy" turns into "everything matches everything",
 * because any short query is a subsequence of half the vocabulary. Two rules
 * hold it in: the query must be at least three characters, and the letters it
 * matched must not be spread over more than a few times their own length. `ag`
 * would otherwise find `pricing/negotiation` and every other word with an a
 * before a g in it.
 */

/** How far apart the matched letters may be, as a multiple of the query. */
const SPREAD = 3.5

/**
 * Where each letter of `query` lands in `text`, greedily and in order, or null.
 * Greedy is right here: the earliest match is the tightest one for a prefix-ish
 * query, which is what people type.
 */
function positions(text, query) {
  const found = []
  let from = 0
  for (const letter of query) {
    const index = text.indexOf(letter, from)
    if (index === -1) return null
    found.push(index)
    from = index + 1
  }
  return found
}

/**
 * How well `text` answers `query`. Higher is better; 0 is no answer at all.
 */
export function score(text, query) {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase().trim()
  if (!needle) return 1
  if (haystack === needle) return 1000

  // Flat, not shorter-is-better: everything under `pri` matches it equally
  // well, and the tie is broken alphabetically so the list reads like the tree
  // -- pricing, pricing/discounts, pricing/terms -- rather than by length.
  if (haystack.startsWith(needle)) return 900
  // The last level counts as a start of its own: after `pricing/` you are
  // typing the sublevel, not the path.
  const leaf = haystack.slice(haystack.lastIndexOf('/') + 1)
  if (leaf.startsWith(needle)) return 800

  const inside = haystack.indexOf(needle)
  if (inside !== -1) return 700 - inside

  if (needle.length < 3) return 0
  const found = positions(haystack, needle)
  if (!found) return 0
  const spread = found[found.length - 1] - found[0] + 1
  if (spread > needle.length * SPREAD) return 0
  return 500 - spread
}

/**
 * The names worth offering for what has been typed so far, best first.
 *
 * @param {string[]} names the vocabulary
 * @param {string} query what has been typed
 * @param {{limit?: number, exclude?: string[]}} [options]
 */
export function suggest(names, query, { limit = 8, exclude = [] } = {}) {
  const skip = new Set(exclude)
  return names
    .filter((name) => !skip.has(name))
    .map((name) => ({ name, score: score(name, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name)
}

/**
 * A text field with a list under it.
 *
 * Not `<input list>` and a `<datalist>`, which is what this was: the browser
 * decides when to show that, matches only by prefix, and on some platforms
 * keeps offering entries that no longer match. This one narrows as you type,
 * moves with the arrow keys, and takes Enter for the highlighted entry or for
 * exactly what was typed if there is none.
 *
 * @param {object} options
 * @param {HTMLInputElement} options.input
 * @param {() => string[]} options.names asked on every keystroke, so a tag added
 *   a moment ago is offered a moment later
 * @param {() => string[]} [options.exclude] names already used here
 * @param {(name: string) => void} options.onPick
 */
export function attachSuggest({ input, names, exclude = () => [], onPick }) {
  const list = document.createElement('ul')
  list.className = 'suggest'
  list.setAttribute('role', 'listbox')
  list.hidden = true
  input.insertAdjacentElement('afterend', list)

  let shown = []
  let active = -1

  const paint = () => {
    list.replaceChildren(
      ...shown.map((name, index) => {
        const item = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `suggest__item${index === active ? ' is-active' : ''}`
        button.textContent = name
        button.setAttribute('role', 'option')
        button.dataset.name = name
        // `mousedown` rather than `click`: the field loses focus first
        // otherwise, and blur is what commits a comment elsewhere on this page.
        button.addEventListener('mousedown', (event) => {
          event.preventDefault()
          pick(name)
        })
        item.append(button)
        return item
      }),
    )
    list.hidden = shown.length === 0
  }

  const refresh = () => {
    shown = suggest(names(), input.value, { exclude: exclude() })
    active = shown.length ? 0 : -1
    paint()
  }

  const close = () => {
    shown = []
    active = -1
    list.hidden = true
    list.replaceChildren()
  }

  const pick = (name) => {
    close()
    onPick(name)
  }

  input.addEventListener('input', refresh)
  input.addEventListener('focus', refresh)
  input.addEventListener('blur', () => setTimeout(close, 120))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!shown.length) return
      event.preventDefault()
      active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length
      paint()
      return
    }
    if (event.key === 'Escape' && !list.hidden) {
      // The list first, the panel after: one press, one dismissal.
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    // What is highlighted, or exactly what was typed -- a suggestion list that
    // hijacked Enter would make a new sublevel impossible to type.
    pick(active >= 0 && shown[active] ? shown[active] : input.value)
  })

  return { refresh, close }
}
