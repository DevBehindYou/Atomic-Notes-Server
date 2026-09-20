/**
 * An error whose code is safe to show the client, with the HTTP status to send it with.
 * [details] are extra fields for the response body, for example how long to wait.
 */
export function httpError(code: string, status: 401 | 409 | 429, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), { status, expose: true as const, details });
}
