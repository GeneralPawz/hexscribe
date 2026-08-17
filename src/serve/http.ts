/**
 * node:http <-> Fetch API adapter, plus the listening socket's lifecycle.
 *
 * Handlers are written against the standard `Request`/`Response` pair rather
 * than Node's streams: it keeps route code free of transport details, gives
 * multipart parsing for free (`request.formData()`), and makes handlers
 * testable without a socket.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { payloadTooLarge } from './errors.ts'

export interface ServerOptions {
  host: string
  port: number
  /** Requests declaring more than this are rejected before the body is read. */
  maxBodyBytes: number
}

export interface RunningServer {
  server: Server
  url: string
  close(): Promise<void>
}

/** Methods that never carry a body, so `Request` must not be given one. */
const BODILESS = new Set(['GET', 'HEAD'])

export function toRequest(message: IncomingMessage, origin: string): Request {
  const method = message.method ?? 'GET'
  const headers = new Headers()
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item)
  }
  return new Request(new URL(message.url ?? '/', origin), {
    method,
    headers,
    body: BODILESS.has(method) ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>),
    // Required by undici when streaming a request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

export async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    target.end()
    return
  }
  await Readable.fromWeb(response.body as never).pipe(target)
}

export async function startServer(
  options: ServerOptions,
  handle: (request: Request) => Promise<Response>,
  onError: (error: unknown) => Response,
): Promise<RunningServer> {
  const server = createServer((message, target) => {
    void (async () => {
      try {
        // Refuse on the declared length, before reading a byte of the body.
        const declared = Number(message.headers['content-length'] ?? 0)
        if (declared > options.maxBodyBytes) {
          message.resume() // drain, or the client sees a connection reset instead
          const tooLarge = payloadTooLarge(
            `Body of ${declared} bytes exceeds the ${options.maxBodyBytes} byte limit.`,
          )
          await writeResponse(onError(tooLarge), target)
          return
        }
        const origin = `http://${message.headers.host ?? `${options.host}:${options.port}`}`
        await writeResponse(await handle(toRequest(message, origin)), target)
      } catch (error) {
        if (target.headersSent) {
          target.destroy()
          return
        }
        await writeResponse(onError(error), target).catch(() => target.destroy())
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://${options.host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
