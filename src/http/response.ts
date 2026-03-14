/**
 * HTTP response helpers that stay framework-agnostic.
 */

export interface RedirectResponseInit {
  headers?: HeadersInit;
  status?: number;
}

/**
 * Create a redirect response without relying on a router/framework helper.
 */
export function createRedirectResponse(
  location: string,
  init: RedirectResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set('Location', location);

  return new Response(null, {
    status: init.status ?? 302,
    headers,
  });
}
