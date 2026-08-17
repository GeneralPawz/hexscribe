/**
 * A router small enough to read in one sitting.
 *
 * Exact-path matching only: this serves a fixed, externally specified API
 * surface, so pattern matching and path parameters would be machinery with no
 * caller. It distinguishes 404 from 405 because clients probing for
 * compatibility deserve the difference.
 */

import { HttpError, notFound } from './errors.ts'

export type Handler = (request: Request) => Promise<Response> | Response

interface Route {
  method: string
  path: string
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  /** @returns a disposer that removes the route again. */
  add(method: string, path: string, handler: Handler): () => void {
    const route: Route = { method: method.toUpperCase(), path, handler }
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }

  list(): ReadonlyArray<{ method: string; path: string }> {
    return this.routes.map(({ method, path }) => ({ method, path }))
  }

  async dispatch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    const samePath = this.routes.filter((route) => route.path === pathname)

    if (!samePath.length) {
      throw notFound(`Unknown path: ${pathname}`, 'unknown_url')
    }
    const route = samePath.find((candidate) => candidate.method === request.method)
    if (!route) {
      throw new HttpError(
        405,
        `Method ${request.method} not allowed on ${pathname}. Allowed: ${samePath
          .map((candidate) => candidate.method)
          .join(', ')}`,
        'invalid_request_error',
        'method_not_supported',
      )
    }
    return route.handler(request)
  }
}
