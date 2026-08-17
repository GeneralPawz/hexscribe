/** OpenAI-shaped error envelope. Every failure leaves the server through here. */

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'server_error'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: ErrorType = 'invalid_request_error',
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, code?: string) => new HttpError(400, message, 'invalid_request_error', code)
export const unauthorized = (message = 'Incorrect API key provided.') =>
  new HttpError(401, message, 'authentication_error', 'invalid_api_key')
export const notFound = (message: string, code?: string) => new HttpError(404, message, 'not_found_error', code)
export const payloadTooLarge = (message: string) =>
  new HttpError(413, message, 'invalid_request_error', 'file_too_large')

export function errorResponse(error: unknown): Response {
  const http =
    error instanceof HttpError
      ? error
      : new HttpError(500, error instanceof Error ? error.message : String(error), 'server_error')

  return Response.json(
    { error: { message: http.message, type: http.type, code: http.code ?? null, param: null } },
    { status: http.status },
  )
}
