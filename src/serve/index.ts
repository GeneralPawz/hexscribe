import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '../asr.ts'
import { requireAuth } from './auth.ts'
import { Config } from './config.ts'
import { errorResponse } from './errors.ts'
import { startServer, type RunningServer } from './http.ts'
import { Router, type Handler } from './router.ts'
import { createAudioHandler } from './routes/audio.ts'
import { createHealthHandler } from './routes/health.ts'
import { createModelsHandler } from './routes/models.ts'
import type { ServeDeps } from './types.ts'

export { Config }
export type { Config as ServeConfig } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    serve: ServeService
  }
}

/**
 * The HTTP front-end: an OpenAI-compatible `/v1/audio/*` surface over `ctx.asr`.
 *
 * The listening socket is an effect, so unloading this plugin closes it. Routes
 * are a registry rather than a fixed table -- `ctx.serve.route()` attaches to the
 * *calling* plugin's fiber, so another plugin can add an endpoint and take it
 * away again without this file knowing.
 */
export class ServeService extends Service {
  private router = new Router()
  private starting?: Promise<RunningServer>
  private running?: RunningServer

  constructor(
    ctx: Context,
    public config: Config,
  ) {
    super(ctx, 'serve')

    ctx.effect(() => {
      this.starting = startServer(
        { host: config.host, port: config.port, maxBodyBytes: config.maxUploadBytes },
        (request) => this.handle(request),
        errorResponse,
      ).then((running) => {
        this.running = running
        ctx.logger?.info?.(`listening on ${running.url}`)
        process.stderr.write(`hexscribe: listening on ${running.url}\n`)
        return running
      })

      // A server that cannot bind is not a degraded server, it is no server --
      // and this composition has no console exporter attached to ctx.logger, so
      // swallowing the rejection here once left a live process with a dead
      // socket and nothing on screen to say so. Report on stderr, loudly.
      this.starting.catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        const inUse = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        process.stderr.write(
          `hexscribe: cannot listen on ${config.host}:${config.port} -- ${detail}\n` +
            (inUse ? `hexscribe: something else is already using that port.\n` : ''),
        )
      })

      return async () => {
        const running = await this.starting?.catch(() => undefined)
        await running?.close()
        this.running = undefined
        this.starting = undefined
      }
    }, 'http-server')
  }

  /** Register a route for the lifetime of the calling plugin. */
  route(method: string, path: string, handler: Handler) {
    return this.ctx.effect(() => this.router.add(method, path, handler), `route:${method} ${path}`)
  }

  /** Resolves once the socket is listening; rejects if it could not bind. */
  async ready(): Promise<string> {
    if (!this.starting) throw new Error('server is not running')
    return (await this.starting).url
  }

  get url(): string | undefined {
    return this.running?.url
  }

  get routes() {
    return this.router.list()
  }

  private async handle(request: Request): Promise<Response> {
    try {
      requireAuth(request, this.config)
      return await this.router.dispatch(request)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

export const name = 'serve'
export const inject = ['asr']

export function apply(ctx: Context, config: Config) {
  ctx.plugin(ServeService, config)

  // Mounted through the same public registry any other plugin would use.
  ctx.inject(['serve'], (self: Context) => {
    const deps: ServeDeps = { ctx: self, config }
    self.serve.route('POST', '/v1/audio/transcriptions', createAudioHandler(deps, 'transcribe'))
    self.serve.route('POST', '/v1/audio/translations', createAudioHandler(deps, 'translate'))
    self.serve.route('GET', '/v1/models', createModelsHandler(deps))
    self.serve.route('GET', '/health', createHealthHandler(deps))
  })
}
