/** An error whose code is safe to show the client, with the HTTP status to send it with. */
export function httpError(code: string, status: 401 | 409) {
  return Object.assign(new Error(code), { status, expose: true as const });
}
