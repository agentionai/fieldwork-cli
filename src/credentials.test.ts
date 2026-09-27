import { afterEach, expect, it, vi } from 'vitest';
import { request } from './client.js';

afterEach(() => vi.unstubAllGlobals());

/** Captures what the client actually puts on the wire. The point of these tests is the
 *  headers, so nothing is mocked above fetch. */
function capture(status = 200, body: unknown = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({
        url: String(url),
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>),
        ),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

it('sends a bearer credential and organization when it has them', async () => {
  const calls = capture();
  await request('http://api.test', '/products', 'GET', undefined, {
    token: 'secret-token',
    organization: 'org_a',
  });
  expect(calls[0]?.headers).toMatchObject({
    Authorization: 'Bearer secret-token',
    'X-Fieldwork-Organization': 'org_a',
  });
});

it('sends neither header when it has no credential, rather than an empty one', async () => {
  const calls = capture();
  await request('http://api.test', '/products');
  // An empty Authorization header reads as a malformed credential rather than none, and
  // the Worker rejects those identically -- but a local deployment needs no credential at
  // all, and sending a blank one would make that request look like a failed attempt.
  expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  expect(calls[0]?.headers).not.toHaveProperty('X-Fieldwork-Organization');
});

it('explains a 401 as a missing credential rather than a retryable failure', async () => {
  capture(401, { code: 'UNAUTHENTICATED', message: 'Unauthenticated' });
  const error = await request('http://api.test', '/products').catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: 'UNAUTHENTICATED',
    status: 401,
    hint: expect.stringContaining('--token'),
  });
  expect((error as { hint: string }).hint).toContain('will not succeed');
});

it('explains a 403 as the wrong organization or a withdrawn grant', async () => {
  capture(403, { code: 'FORBIDDEN', message: 'Forbidden' });
  const error = await request('http://api.test', '/products', 'GET', undefined, {
    token: 'valid',
    organization: 'org_b',
  }).catch((e: unknown) => e);
  expect((error as { hint: string }).hint).toContain('--org');
  expect((error as { hint: string }).hint).toContain('revoked');
});
