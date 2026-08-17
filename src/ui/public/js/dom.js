/** Tiny DOM helpers. Enough to avoid a framework, not enough to become one. */

export const $ = (selector, root = document) => root.querySelector(selector)

export function show(element, visible = true) {
  element.hidden = !visible
}

/** `93.4` -> `1:33`, `3812` -> `1:03:32`. */
export function clock(seconds) {
  const total = Math.max(0, Math.round(seconds))
  const parts = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
  const [h, m, s] = parts
  const pad = (value) => String(value).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function humanSize(bytes) {
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

/** Hand the browser a file without leaking the object URL. */
export function saveFile(text, filename, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
