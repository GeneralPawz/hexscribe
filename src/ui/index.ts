import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../serve/index.ts'
import { createFormatHandler } from './format.ts'
import { collectAssets, serveAsset } from './static.ts'

export interface Config {
  path: string
  assetPrefix: string
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().default('/').description('Where the page is served.'),
  assetPrefix: Schema.string().default('/ui').description('URL prefix for the page assets.'),
})

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public')

/**
 * The browser front-end.
 *
 * A separate plugin that owns nothing but its routes: it injects `serve` and
 * registers through the public `ctx.serve.route()` registry, exactly as any
 * third-party plugin would. Remove this entry from `cordis.yml` and the server
 * is a bare JSON API again, with the page's routes gone with it.
 */
export const name = 'ui'
export const inject = ['serve']

export function apply(ctx: Context, config: Config) {
  ctx.serve.route('POST', '/ui/format', createFormatHandler())

  // Route registration is async (the directory is read first), so it is wrapped
  // in an effect: unloading mid-scan must not leave routes behind.
  ctx.effect(async () => {
    const assets = await collectAssets(PUBLIC_DIR, config.assetPrefix)
    const disposers = assets.map((asset) => ctx.serve.route('GET', asset.url, serveAsset(asset)))

    const index = assets.find((asset) => asset.url.endsWith('/index.html'))
    if (index) disposers.push(ctx.serve.route('GET', config.path, serveAsset(index)))

    ctx.logger?.info?.(`ui on ${config.path} (${assets.length} assets)`)
    return () => disposers.forEach((dispose) => dispose())
  }, 'ui-routes')
}
