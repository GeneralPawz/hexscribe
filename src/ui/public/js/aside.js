/**
 * The panel that slides in from the right.
 *
 * One panel, many contents: a speaker's identity, the download options, and
 * whatever comes next. It owns being *a panel* — sliding in, closing on Escape,
 * putting focus in the right place, announcing itself to a screen reader — and
 * knows nothing about what it is showing. Content modules own the other half:
 * they get an empty element and return a disposer.
 *
 * Non-modal on purpose. There is no scrim and the transcript stays clickable,
 * because the things this panel does are *about* the transcript: naming the
 * speaker of the row you are reading, or choosing what to export from it. A
 * modal would hide the thing being talked about.
 */

/**
 * @typedef {{ id: string, label: string, mount: (body: HTMLElement) => (() => void) | void }} Tab
 * @typedef {{
 *   title: string,
 *   mount?: (body: HTMLElement) => (() => void) | void,
 *   tabs?: Tab[],
 *   active?: string,
 *   onTab?: (id: string) => void,
 * }} Panel
 *
 * A panel is either one body or a row of tabs. Tabs exist because two of these
 * views are about the same thing at different scales — every speaker, and one
 * speaker's utterances — and moving between them should not feel like leaving.
 */

let current = null

export function isAsideOpen() {
  return Boolean(current)
}

/** The panel's own key, so a caller can tell whether Escape was already used. */
export function closeAside() {
  if (!current) return false
  current.dispose()
  current = null
  return true
}

/**
 * @param {Panel} panel
 * @returns {void}
 */
export function openAside(panel) {
  const host = document.querySelector('#aside')
  if (!host) return

  // Reopening onto different content should not animate out and back in, so the
  // old contents are disposed in place and the panel simply changes what it is.
  const wasOpen = Boolean(current)
  current?.dispose(true)

  const previousFocus = document.activeElement

  host.replaceChildren()
  host.hidden = false
  host.setAttribute('aria-label', panel.title)

  const header = document.createElement('header')
  header.className = 'aside__head'

  const heading = document.createElement('h2')
  heading.className = 'aside__title'
  heading.textContent = panel.title
  header.append(heading)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'aside__close'
  close.setAttribute('aria-label', 'Close')
  close.textContent = '×'
  close.addEventListener('click', () => closeAside())
  header.append(close)

  const body = document.createElement('div')
  body.className = 'aside__body'

  host.append(header)

  // Tabs, when there are any. The strip goes under the title so the panel keeps
  // one heading and the tabs read as places within it rather than as separate
  // panels that happen to look alike.
  let switchTab = null
  // Whatever is currently mounted, tab or plain body, so closing the panel
  // disposes it either way.
  let disposeContent = () => {}

  if (panel.tabs?.length) {
    const strip = document.createElement('div')
    strip.className = 'aside__tabs'
    strip.setAttribute('role', 'tablist')

    let activeId = panel.active ?? panel.tabs[0].id

    const buttons = panel.tabs.map((tab) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'aside__tab'
      button.textContent = tab.label
      button.dataset.tab = tab.id
      button.setAttribute('role', 'tab')
      button.addEventListener('click', () => switchTab(tab.id))
      strip.append(button)
      return button
    })

    switchTab = (id) => {
      const tab = panel.tabs.find((entry) => entry.id === id) ?? panel.tabs[0]
      activeId = tab.id
      for (const button of buttons) {
        const on = button.dataset.tab === tab.id
        button.classList.toggle('is-active', on)
        button.setAttribute('aria-selected', String(on))
      }
      disposeContent()
      body.replaceChildren()
      disposeContent = tab.mount(body) ?? (() => {})
      panel.onTab?.(tab.id)
    }

    host.append(strip, body)
    switchTab(activeId)
  } else {
    host.append(body)
  }
  // The class drives the transition; setting it after `hidden` is cleared means
  // the browser has a frame to lay the panel out off-screen before it moves.
  requestAnimationFrame(() => host.classList.add('is-open'))
  // And the page gives up the width, so the panel never covers the transcript
  // it is talking about.
  document.body.classList.add('has-aside')

  if (!panel.tabs?.length) disposeContent = panel.mount?.(body) ?? (() => {})

  const onKey = (event) => {
    if (event.key !== 'Escape') return
    // Consumed here: Escape also gives up a row selection, and one press should
    // dismiss one thing -- the innermost first, which is this.
    event.preventDefault()
    event.stopPropagation()
    closeAside()
  }
  host.addEventListener('keydown', onKey)

  current = {
    /** Move to another tab from outside — what a speaker row does. */
    show: switchTab,
    dispose(replacing = false) {
      disposeContent()
      host.removeEventListener('keydown', onKey)
      if (replacing) return
      host.classList.remove('is-open')
      document.body.classList.remove('has-aside')
      host.hidden = true
      host.replaceChildren()
      // Only take focus back if it is still inside the panel; a person who has
      // clicked into the transcript should not be yanked out of it.
      if (previousFocus instanceof HTMLElement && host.contains(document.activeElement)) {
        previousFocus.focus()
      }
    },
  }

  if (!wasOpen) queueMicrotask(() => body.querySelector('input, select, button')?.focus())
  return { show: (id) => switchTab?.(id) }
}

// --- small builders, shared by the panels ------------------------------

/** A labelled control. Returns the wrapper so a caller can place it. */
export function field(label, control) {
  const wrapper = document.createElement('label')
  wrapper.className = 'aside__field'
  const text = document.createElement('span')
  text.textContent = label
  wrapper.append(text, control)
  return wrapper
}

/** A definition row: what something is, and what it is worth. */
export function stat(label, value) {
  const row = document.createElement('div')
  row.className = 'aside__stat'
  const key = document.createElement('span')
  key.textContent = label
  const worth = document.createElement('strong')
  worth.textContent = value
  row.append(key, worth)
  return row
}

export function note(text, tone = '') {
  const paragraph = document.createElement('p')
  paragraph.className = `aside__note${tone ? ` aside__note--${tone}` : ''}`
  paragraph.textContent = text
  return paragraph
}

export function button(label, { primary = false, onClick } = {}) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `tool${primary ? ' tool--primary' : ''}`
  element.textContent = label
  if (onClick) element.addEventListener('click', onClick)
  return element
}

export function row(...children) {
  const element = document.createElement('div')
  element.className = 'aside__row'
  element.append(...children)
  return element
}
