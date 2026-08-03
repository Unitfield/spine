import { describe, expect, it, vi } from 'vitest';

import { createFetchMiddleware } from '../../src/api-client/fetch-client.server';
import type { TokenRefreshResult } from '../../src/api-client/types';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe('createFetchMiddleware token refresh isolation', () => {
  it('does not share a refresh result between sessions with the same cookie prefix', async () => {
    const commonPrefix = `theme=system; tenant=${'a'.repeat(40)}; session=`;
    const requestA = new Request('https://app.example.test/data', {
      headers: { cookie: `${commonPrefix}session-a` },
    });
    const requestB = new Request('https://app.example.test/data', {
      headers: { cookie: `${commonPrefix}session-b` },
    });

    const refreshA = createDeferred<TokenRefreshResult>();
    const attemptRefreshA = vi.fn(() => refreshA.promise);
    const attemptRefreshB = vi.fn(async (): Promise<TokenRefreshResult> => ({
      success: true,
      newAccessToken: 'token-b',
    }));
    const retryA = vi.fn(async (_url: string, init: RequestInit) =>
      new Response(new Headers(init.headers).get('Authorization') ?? '', { status: 200 }));
    const retryB = vi.fn(async (_url: string, init: RequestInit) =>
      new Response(new Headers(init.headers).get('Authorization') ?? '', { status: 200 }));

    const middlewareA = createFetchMiddleware(requestA, {
      attemptTokenRefresh: attemptRefreshA,
      retryConfig: { maxRetries: 0 },
    })[0];
    const middlewareB = createFetchMiddleware(requestB, {
      attemptTokenRefresh: attemptRefreshB,
      retryConfig: { maxRetries: 0 },
    })[0];

    const postA = middlewareA.post!({
      url: 'https://api.example.test/data',
      init: { headers: { Authorization: 'Bearer expired-a' } },
      response: new Response(null, { status: 401 }),
      fetch: retryA,
    });

    await Promise.resolve();

    const postB = middlewareB.post!({
      url: 'https://api.example.test/data',
      init: { headers: { Authorization: 'Bearer expired-b' } },
      response: new Response(null, { status: 401 }),
      fetch: retryB,
    });

    refreshA.resolve({ success: true, newAccessToken: 'token-a' });

    const [responseA, responseB] = await Promise.all([postA, postB]);

    expect(attemptRefreshA).toHaveBeenCalledOnce();
    expect(attemptRefreshB).toHaveBeenCalledOnce();
    expect(await responseA.text()).toBe('Bearer token-a');
    expect(await responseB.text()).toBe('Bearer token-b');
  });
});
