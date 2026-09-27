import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './client.js';

afterEach(() => vi.unstubAllGlobals());

describe('request failure handling', () => {
  it('marks disconnected writes as having an unknown outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(
      request('http://fieldwork.test', '/runs/one/record', 'POST', {}),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      // Named: the server comes from a flag, two environment variables, a workspace file
      // or a default, and the reader cannot tell which was in force without being told.
      message: 'Could not reach the server at http://fieldwork.test',
      hint: expect.stringContaining('may have committed'),
    });
  });

  it('identifies timeouts and says reads are safe to retry', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

    await expect(request('http://fieldwork.test', '/campaigns')).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'Request to http://fieldwork.test timed out after 15 seconds',
      hint: 'This read is safe to retry.',
    });
  });

  it('retains the server request ID on API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'REVISION_CONFLICT', message: 'Changed', requestId: 'req-7' }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );

    await expect(request('http://fieldwork.test', '/runs/one', 'PATCH', {})).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      status: 409,
      requestId: 'req-7',
    });
  });
});
