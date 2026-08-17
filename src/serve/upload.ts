/**
 * Uploaded audio -> a real file on disk.
 *
 * The ASR seam takes a path, not bytes: the NPU engine hands the path to a
 * separate Python process, which decodes it with FFmpeg. So an upload has to
 * land on disk somewhere, and whoever put it there has to remove it.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'

export interface Upload {
  /** Absolute path to the temporary file. */
  path: string
  /** The client's original filename, for diagnostics. */
  filename: string
  bytes: number
  /** Idempotent; safe to call from a `finally`. */
  cleanup(): Promise<void>
}

/** Keep only a safe extension from the client's name -- FFmpeg sniffs content anyway. */
function safeExtension(filename: string): string {
  const extension = extname(filename).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin'
}

export async function saveUpload(file: File, directory: string): Promise<Upload> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${randomUUID()}${safeExtension(file.name || 'audio')}`)
  const bytes = Buffer.from(await file.arrayBuffer())
  await writeFile(path, bytes)

  let removed = false
  return {
    path,
    filename: file.name || 'audio',
    bytes: bytes.byteLength,
    async cleanup() {
      if (removed) return
      removed = true
      await rm(path, { force: true })
    },
  }
}
