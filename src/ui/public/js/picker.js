/**
 * Choosing a file that stays where it is.
 *
 * The browser cannot help with this. A file input hands over a name and bytes
 * and deliberately never a path, so "transcribe that file over there" is a
 * sentence the page has no way to say. The server does — it is running on the
 * same machine — so the browsing happens there and this is the view of it.
 *
 * Worth the trouble because the alternative is copying an interview through the
 * browser's memory, over a socket to localhost, into a temporary file, and then
 * deleting it. Measured on a 180 MB recording: 189 MB uploaded and 4 seconds,
 * against 557 bytes and a tenth of a second.
 */

import { listFiles } from './api.js'
import { humanSize } from './dom.js'

/**
 * @param {object} options
 * @param {(file: {path: string, name: string, bytes: number}) => void} options.onPick
 * @param {string} [options.start] folder to open in
 */
export function filePicker({ onPick, start }) {
  return {
    title: 'Choose a file on this machine',
    mount(body, close) {
      const here = document.createElement('input')
      here.type = 'text'
      here.className = 'modal__input modal__input--path'
      here.spellcheck = false
      here.setAttribute('aria-label', 'Folder')

      const up = document.createElement('button')
      up.type = 'button'
      up.className = 'tool'
      up.textContent = '↑'
      up.title = 'Parent folder'

      const bar = document.createElement('div')
      bar.className = 'picker__bar'
      bar.append(up, here)

      const list = document.createElement('ul')
      list.className = 'picker__list'

      const status = document.createElement('p')
      status.className = 'modal__note'

      body.append(bar, list, status)

      let live = true
      let parent = null

      async function show(path) {
        status.textContent = 'Reading…'
        try {
          const result = await listFiles(path)
          if (!live) return
          if (!result) {
            status.textContent =
              'This server will not browse the filesystem. It only does so when bound to localhost, or with an api key set.'
            return
          }
          here.value = result.path
          parent = result.parent
          up.disabled = !parent
          status.textContent = result.entries.length ? '' : 'Nothing here that this can open.'

          list.replaceChildren(
            ...result.entries.map((entry) => {
              const item = document.createElement('li')
              const button = document.createElement('button')
              button.type = 'button'
              button.className = `picker__entry${entry.directory ? ' is-folder' : ''}`

              const icon = document.createElement('span')
              icon.className = 'picker__icon'
              icon.textContent = entry.directory ? '📁' : '♪'

              const name = document.createElement('span')
              name.className = 'picker__name'
              name.textContent = entry.name

              const size = document.createElement('span')
              size.className = 'picker__size'
              size.textContent = entry.directory ? '' : humanSize(entry.bytes)

              button.append(icon, name, size)
              button.addEventListener('click', () => {
                if (entry.directory) show(entry.path)
                else {
                  onPick({ path: entry.path, name: entry.name, bytes: entry.bytes })
                  close()
                }
              })
              item.append(button)
              return item
            }),
          )
        } catch (error) {
          if (live) status.textContent = error.message
        }
      }

      up.addEventListener('click', () => parent && show(parent))
      // Typing a path is the faster route when you already know it, and the
      // only route to a folder the listing will not show you.
      here.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          show(here.value.trim())
        }
      })

      show(start)

      return () => {
        live = false
      }
    },
  }
}
