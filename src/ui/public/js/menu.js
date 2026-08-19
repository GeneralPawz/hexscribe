/**
 * A context menu, small enough to own.
 *
 * Right-clicking a transcript row is the natural place for actions that apply
 * to *that* row, and it keeps the transcript itself clean — the alternative was
 * two buttons on every line, which turned a document into a control panel.
 *
 * Being a custom menu, it has to earn back what the native one gives for free:
 * it closes on Escape, on a click elsewhere, and on scroll; it keeps itself
 * inside the viewport; arrow keys move through it; and focus returns where it
 * came from. The browser's own menu stays one Shift+right-click away.
 */

let open = null

/** Close whatever is open. Safe to call when nothing is. */
export function closeMenu() {
  open?.()
  open = null
}

/**
 * @param {number} x viewport coordinates, usually the pointer
 * @param {number} y
 * @param {Array<
 *   { heading: string } |
 *   {
 *     label: string,
 *     checked?: boolean,
 *     disabled?: boolean,
 *     danger?: boolean,
 *     icon?: () => SVGElement,
 *     onSelect?: () => void,
 *   }
 * >} items
 */
export function openMenu(x, y, items) {
  closeMenu()

  const previousFocus = document.activeElement
  const menu = document.createElement('div')
  menu.className = 'menu'
  menu.setAttribute('role', 'menu')

  const buttons = []
  for (const item of items) {
    // A heading, not an item: it names the scope the entries under it apply to.
    // Not explanatory text — the difference between "this utterance" and "this
    // speaker" is what stops a click meant for one row moving forty of them.
    if (item.heading) {
      const heading = document.createElement('p')
      heading.className = 'menu__heading'
      heading.textContent = item.heading
      menu.append(heading)
      continue
    }

    const button = document.createElement('button')
    button.type = 'button'
    // Red for the ones that take something away for good. There is no undo for
    // forgetting a tag or a voice, and a menu where every line looks the same
    // is a menu where the irreversible one is a slip of the pointer away.
    button.className = `menu__item${item.danger ? ' menu__item--danger' : ''}`
    button.setAttribute('role', 'menuitem')
    button.disabled = Boolean(item.disabled)

    // A mark, not a sentence: the menu says what an item does by being named
    // well, and a column of explanations makes a short list feel long.
    const mark = document.createElement('span')
    mark.className = 'menu__mark'
    if (item.checked) mark.textContent = '✓'
    else if (item.icon) mark.append(item.icon())
    button.append(mark)

    const label = document.createElement('span')
    label.textContent = item.label
    button.append(label)

    button.addEventListener('click', () => {
      closeMenu()
      item.onSelect?.()
    })
    menu.append(button)
    buttons.push(button)
  }

  // Placed off-screen first so it can be measured, then nudged back inside.
  menu.style.left = '0px'
  menu.style.top = '0px'
  document.body.append(menu)
  const bounds = menu.getBoundingClientRect()
  const left = Math.min(x, window.innerWidth - bounds.width - 8)
  const top = Math.min(y, window.innerHeight - bounds.height - 8)
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`

  const enabled = buttons.filter((button) => !button.disabled)
  enabled[0]?.focus()

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Consumed: Escape also gives up a row selection, and one press should
      // dismiss one thing. This listener is in the capture phase, so stopping
      // here keeps the key from reaching anything further out.
      event.stopPropagation()
      closeMenu()
      previousFocus instanceof HTMLElement && previousFocus.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const at = enabled.indexOf(document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    enabled[(at + step + enabled.length) % enabled.length]?.focus()
  }

  const onPointerDown = (event) => {
    if (!menu.contains(event.target)) closeMenu()
  }

  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('scroll', closeMenu, true)
  window.addEventListener('resize', closeMenu)

  open = () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('scroll', closeMenu, true)
    window.removeEventListener('resize', closeMenu)
    menu.remove()
  }
}

/**
 * Character offset in `text` nearest to a point on screen, snapped to a word gap.
 *
 * This is what makes "split here" mean *here*: the caret position under the
 * pointer, moved to the nearest space so a split never lands inside a word.
 *
 * @returns {number | null} null when the point is not over the text
 */
export function offsetFromPoint(element, text, x, y) {
  const range = document.caretRangeFromPoint?.(x, y)
  if (!range || !element.contains(range.startContainer)) return null

  // Offsets are per text node; sum the ones before it to get the text offset.
  let offset = 0
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && node !== range.startContainer) {
    offset += node.textContent.length
    node = walker.nextNode()
  }
  if (!node) return null
  offset += range.startOffset

  return snapToWordGap(text, offset)
}

/** @returns {number} the nearest boundary between words, or the offset itself. */
export function snapToWordGap(text, offset) {
  if (offset <= 0 || offset >= text.length) return offset
  if (/\s/.test(text[offset]) || /\s/.test(text[offset - 1])) return offset

  let before = offset
  while (before > 0 && !/\s/.test(text[before - 1])) before--
  let after = offset
  while (after < text.length && !/\s/.test(text[after])) after++

  return offset - before <= after - offset ? before : after
}
