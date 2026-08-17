/**
 * Static assets for the browser UI.
 *
 * The public directory is enumerated once at load and each file gets its own
 * route, which means the router keeps its exact-match simplicity and path
 * traversal is impossible by construction: a request never contributes to a
 * filesystem path, it only looks up a table this module built.
 *
 * Files are read per request (they are small and local), so editing the CSS and
 * hitting reload works without restarting the server.
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, posix, relative, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export interface Asset {
  /** URL path, e.g. `/ui/js/main.js`. */
  url: string
  /** Absolute path on disk. */
  file: string
  contentType: string
}

export async function collectAssets(directory: string, urlPrefix: string): Promise<Asset[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name)
      const url = posix.join(urlPrefix, relative(directory, file).split(sep).join('/'))
      return {
        url,
        file,
        contentType: CONTENT_TYPES[extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
      }
    })
}

export function serveAsset(asset: Asset) {
  return async () =>
    new Response(await readFile(asset.file), {
      headers: {
        'content-type': asset.contentType,
        // A local tool that people will edit: never let a stale asset win.
        'cache-control': 'no-store',
      },
    })
}
