/**
 * A modal dialog, on the platform's own terms.
 *
 * `<dialog showModal()>` rather than a div and a scrim: the browser already
 * knows how to trap focus, close on Escape, render a backdrop, and put the thing
 * above everything regardless of z-index. Reimplementing that is a lot of code
 * to arrive back where the platform started.
 *
 * The right-hand aside and this are deliberately different: the aside is *about*
 * something on the page and leaves it visible, and a modal is a detour — settings
 * and file-picking are not about the transcript you happen to be reading.
 */

/** @typedef {{ title: string, mount: (body: HTMLElement, close: () => void) => (() => void) | void }} Modal */

let current = null

export function closeModal() {
  if (!current) return false
  current.close()
  return true
}

export function isModalOpen() {
  return Boolean(current)
}

/** @param {Modal} modal */
export function openModal(modal) {
  const host = document.querySelector('#modal')
  if (!host) return
  closeModal()

  host.replaceChildren()
  host.setAttribute('aria-label', modal.title)

  const header = document.createElement('header')
  header.className = 'modal__head'
  const heading = document.createElement('h2')
  heading.className = 'modal__title'
  heading.textContent = modal.title
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'modal__close'
  dismiss.setAttribute('aria-label', 'Close')
  dismiss.textContent = '×'
  header.append(heading, dismiss)

  const body = document.createElement('div')
  body.className = 'modal__body'
  host.append(header, body)

  const close = () => {
    if (current?.host !== host) return
    unmount?.()
    host.removeEventListener('close', onClose)
    host.close()
    host.replaceChildren()
    current = null
  }
  dismiss.addEventListener('click', close)

  // Escape fires the dialog's own `close` event; this keeps our bookkeeping and
  // the platform's agreeing about whether anything is open.
  const onClose = () => close()
  host.addEventListener('close', onClose)

  host.showModal()
  const unmount = modal.mount(body, close) ?? (() => {})
  current = { host, close }

  queueMicrotask(() => body.querySelector('input, select, button')?.focus())
}

// --- builders, shared by the modals ------------------------------------

export function section(title, ...children) {
  const element = document.createElement('section')
  element.className = 'modal__section'
  if (title) {
    const heading = document.createElement('h3')
    heading.className = 'modal__section-title'
    heading.textContent = title
    element.append(heading)
  }
  element.append(...children)
  return element
}

export function field(label, control, hint) {
  const wrapper = document.createElement('label')
  wrapper.className = 'modal__field'
  const text = document.createElement('span')
  text.textContent = label
  wrapper.append(text, control)
  if (hint) {
    const note = document.createElement('small')
    note.className = 'modal__hint'
    note.textContent = hint
    wrapper.append(note)
  }
  return wrapper
}

export function checkField(label, checked, hint) {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  const wrapper = field(label, input, hint)
  wrapper.classList.add('modal__field--check')
  return { wrapper, input }
}

export function stat(label, value) {
  const row = document.createElement('div')
  row.className = 'modal__stat'
  const key = document.createElement('span')
  key.textContent = label
  const worth = document.createElement('strong')
  worth.textContent = value
  row.append(key, worth)
  return row
}
