export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
/** Cross-tenant reads answer 404, never 403, so they do not confirm that an id exists elsewhere. */
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const tooMany = (message: string) => new HttpError(429, 'too_many_requests', message);
