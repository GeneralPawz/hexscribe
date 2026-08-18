/**
 * The drawer along the bottom.
 *
 * The right aside is about one thing: this speaker, this line, this download.
 * There is a second kind of question — *where in this recording is everything
 * about X* — and it is a poor fit for a narrow column, because the answer is a
 * list of lines and you want to see them next to what you picked.
 *
 * So: a sheet along the bottom, collapsed to a handle until it is asked for,
 * open at half the page. Two panes side by side, because the whole gesture is
 * "pick a thing, see its lines", and a version that made you go back to the
 * list between each one would be a worse way to read the same data.
 *
 * It owns being *a drawer* — opening, closing, tabs, Escape, telling the page
 * to make room. What goes in it is somebody else's business, exactly as with
 * the aside, and the panel shape is deliberately the same one.
 */

/**
 * @typedef {{ id: string, label: string, mount: (body: HTMLElement) => (() => void) | void }} Tab
 */

let host = null
let strip = null
let body = null
let provide = () => ({ tabs: [] })
let activeId = null
let disposeContent = () => {}
let open = false

export function isDrawerOpen() {
  return open
}

/**
 * Install the drawer. Called once; the contents are asked for on every paint,
 * so the caller keeps the state and this keeps nothing but which tab is up.
 *
 * @param {() => { tabs: Tab[], label?: string }} provider
 */
export function mountDrawer(provider) {
  provide = provider
  host = document.querySelector('#drawer')
  strip = document.querySelector('#drawer-tabs')
  body = document.querySelector('#drawer-body')
  const handle = document.querySelector('#drawer-handle')
  if (!host || !handle) return

  handle.addEventListener('click', () => (open ? closeDrawer() : openDrawer()))
  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return
    // Consumed here while it is open, so one press dismisses one thing.
    event.preventDefault()
    event.stopPropagation()
    closeDrawer()
  })
  paintHandle()
}

/** Open it, optionally on a particular tab. */
export function openDrawer(id) {
  if (!host) return
  // Nothing to show is not worth opening for: with no transcript on screen the
  // handle would flick open onto an empty half-page and shut again.
  if (!provide().tabs.length) return
  if (id) activeId = id
  open = true
  host.classList.add('is-open')
  document.querySelector('#drawer-handle')?.setAttribute('aria-expanded', 'true')
  document.body.classList.add('has-drawer')
  body.hidden = false
  strip.hidden = false
  refreshDrawer()
  queueMicrotask(() => strip.querySelector('.drawer__tab.is-active')?.focus())
}

export function closeDrawer() {
  if (!host || !open) return false
  open = false
  disposeContent()
  disposeContent = () => {}
  host.classList.remove('is-open')
  document.querySelector('#drawer-handle')?.setAttribute('aria-expanded', 'false')
  document.body.classList.remove('has-drawer')
  body.hidden = true
  strip.hidden = true
  body.replaceChildren()
  strip.replaceChildren()
  paintHandle()
  return true
}

/**
 * Re-ask for the contents and redraw.
 *
 * Called whenever what it is showing changes underneath it — a tag added from
 * the aside, a speaker merged, an edit that moved a line. A drawer showing last
 * minute's answer is worse than one that is shut.
 */
export function refreshDrawer() {
  if (!host) return
  // The handle is repainted even while the drawer is shut, because what it says
  // is about the page and not about itself: opening a run has to reach the
  // label, or it sits there claiming nothing is open over an open transcript.
  paintHandle()
  if (!open) return
  const { tabs } = provide()
  if (!tabs.length) {
    closeDrawer()
    return
  }
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  activeId = active.id

  strip.replaceChildren(
    ...tabs.map((tab) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `drawer__tab${tab.id === activeId ? ' is-active' : ''}`
      button.dataset.tab = tab.id
      button.textContent = tab.label
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(tab.id === activeId))
      button.addEventListener('click', () => {
        activeId = tab.id
        refreshDrawer()
      })
      return button
    }),
  )

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'drawer__close'
  close.setAttribute('aria-label', 'Close')
  close.textContent = '×'
  close.addEventListener('click', () => closeDrawer())
  strip.append(close)

  disposeContent()
  body.replaceChildren()
  disposeContent = active.mount(body) ?? (() => {})
  paintHandle()
}

function paintHandle() {
  const label = document.querySelector('#drawer-label')
  if (!label) return
  const { label: text } = provide()
  label.textContent = text ?? 'Tags and speakers'
}

/**
 * The two-pane split every drawer tab uses: pick on the left, read on the
 * right. Returned as a pair so the caller fills each side.
 */
export function panes(body, { emptyRight = 'Pick something on the left.' } = {}) {
  const split = document.createElement('div')
  split.className = 'drawer__split'

  const left = document.createElement('div')
  left.className = 'drawer__pane drawer__pane--list'

  const right = document.createElement('div')
  right.className = 'drawer__pane drawer__pane--detail'

  const empty = document.createElement('p')
  empty.className = 'aside__note aside__note--muted'
  empty.textContent = emptyRight
  right.append(empty)

  split.append(left, right)
  body.append(split)
  return { left, right }
}
