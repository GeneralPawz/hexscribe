import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { homedir } from 'node:os'
import { extname, join, parse, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from './serve/index.ts'
import { badRequest, notFound } from './serve/errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    localFiles: LocalFileService
  }
}

/**
 * What this will open, and nothing else.
 *
 * A deliberate whitelist rather than a blacklist: the browse endpoint exists to
 * find recordings, and an endpoint that will stream any path a caller names is
 * a file-exfiltration endpoint with a nice UI. Restricting it to media means the
 * worst it can do is what it says it does.
 */
export const MEDIA_EXTENSIONS = new Set([
  '.wav', '.mp3', '.m4a', '.mp4', '.ogg', '.opus', '.flac', '.webm',
  '.aac', '.wma', '.aiff', '.aif', '.mkv', '.mov', '.m4b', '.amr', '.3gp',
])

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
}

export function isMedia(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(path).toLowerCase())
}

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export interface Entry {
  name: string
  path: string
  directory: boolean
  bytes: number
  modified: number
}

/**
 * Reading audio where it already lives.
 *
 * Uploading a 180 MB interview to a server running on the same laptop copies it
 * for no reason: through the browser's memory, over a socket to itself, into a
 * temporary file, and then deletes it. Pointing at the file instead skips all of
 * that — and leaves something to play back later, which a deleted upload cannot.
 *
 * The browser cannot help here. A file input gives a name and bytes and
 * deliberately never a path, so the only way to name a file on this machine is
 * for the server to do the browsing. That is a filesystem API over HTTP, so:
 *
 * - **Loopback only, or an API key.** Bound to a real interface with no key,
 *   this refuses to load and says why. Everything else the server offers is
 *   already a reason not to run it open; this would be a much better reason.
 * - **Media extensions only**, for both listing detail and streaming. The
 *   endpoint can find recordings and cannot read `id_rsa`.
 * - **Read only.** There is no route here that writes, moves or deletes.
 */
export class LocalFileService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'localFiles')
  }

  /** Where to start browsing: the user's own folder. */
  home(): string {
    return homedir()
  }

  async list(directory: string): Promise<{ path: string; parent: string | null; entries: Entry[] }> {
    const here = resolve(directory)
    let dirents
    try {
      dirents = await readdir(here, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw notFound(`No such folder: ${here}`)
      throw badRequest(`Cannot read ${here}: ${code ?? error}`)
    }

    const entries: Entry[] = []
    for (const dirent of dirents) {
      const full = join(here, dirent.name)
      // Directories are always listed (you have to walk through them); files
      // only when they are something this app could actually open.
      if (!dirent.isDirectory() && !isMedia(dirent.name)) continue
      // A folder that cannot be stat'd (permissions, a dead junction) is listed
      // without its details rather than failing the whole listing.
      let bytes = 0
      let modified = 0
      try {
        const info = await stat(full)
        bytes = info.size
        modified = info.mtimeMs
      } catch {
        if (!dirent.isDirectory()) continue
      }
      entries.push({ name: dirent.name, path: full, directory: dirent.isDirectory(), bytes, modified })
    }

    entries.sort((a, b) =>
      a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1,
    )

    const { dir, root } = parse(here)
    return { path: here, parent: here === root ? null : dir, entries }
  }

  /** Check a path is something we will transcribe, and report why if not. */
  async require(path: string): Promise<{ path: string; bytes: number; name: string }> {
    const full = resolve(path)
    if (!isMedia(full)) {
      throw badRequest(
        `${full} is not an audio or video file this can open. ` +
          `Expected one of: ${[...MEDIA_EXTENSIONS].join(', ')}.`,
      )
    }
    let info
    try {
      info = await stat(full)
    } catch {
      throw notFound(`No such file: ${full}`)
    }
    if (!info.isFile()) throw badRequest(`${full} is not a file.`)
    return { path: full, bytes: info.size, name: full.split(/[\\/]/).pop() ?? full }
  }
}

export const name = 'local-files'
export const inject = ['serve']

/** Loopback, or an API key. Anything else and this feature does not exist. */
function isSafeToExpose(host: string, apiKey?: string): boolean {
  if (apiKey) return true
  const bare = host.replace(/^\[|\]$/g, '')
  return bare === '127.0.0.1' || bare === '::1' || bare === 'localhost'
}

export function apply(ctx: Context) {
  const { host, apiKey } = ctx.serve.config
  if (!isSafeToExpose(host, apiKey)) {
    // Refusing loudly rather than quietly: somebody who wanted this and does not
    // get it deserves to know which of the two conditions to fix.
    const message =
      `local-files is disabled: the server is bound to ${host} with no api key, and this plugin ` +
      `lets a caller browse and read media files anywhere on this machine. ` +
      `Bind to 127.0.0.1, or set an apiKey.`
    ctx.logger?.warn?.(message)
    process.stderr.write(`hexscribe: ${message}\n`)
    return
  }

  ctx.plugin(LocalFileService)

  ctx.inject(['localFiles'], (self: Context) => {
    self.serve.route('GET', '/v1/files', async (request) => {
      const wanted = new URL(request.url).searchParams.get('path')
      return Response.json(await self.localFiles.list(wanted || self.localFiles.home()))
    })

    /**
     * Stream a file for playback.
     *
     * Range requests are the point: a browser seeking inside an hour-long MP3
     * asks for the byte window it needs, and without a 206 it would download
     * the whole file to play the last minute.
     */
    self.serve.route('GET', '/v1/files/audio', async (request) => {
      const wanted = new URL(request.url).searchParams.get('path')
      if (!wanted) throw badRequest('Needs a `path`.')
      const file = await self.localFiles.require(wanted)

      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
      const headers: Record<string, string> = {
        'content-type': mimeFor(file.path),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      }

      if (!range) {
        headers['content-length'] = String(file.bytes)
        return new Response(Readable.toWeb(createReadStream(file.path)) as never, { headers })
      }

      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), file.bytes - 1) : file.bytes - 1
      if (!(start >= 0) || start >= file.bytes || end < start) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${file.bytes}` },
        })
      }
      headers['content-range'] = `bytes ${start}-${end}/${file.bytes}`
      headers['content-length'] = String(end - start + 1)
      return new Response(Readable.toWeb(createReadStream(file.path, { start, end })) as never, {
        status: 206,
        headers,
      })
    })
  })
}
