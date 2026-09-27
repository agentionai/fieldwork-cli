import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from './client.js';
import { CLI_VERSION } from './version.js';

/** The CLI names its version on every request; a server answers an older one with advice,
 *  which a failure carries in its error and a success mentions once a day on stderr. */
let config: string;
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'fieldwork-version-'));
  vi.stubEnv('XDG_CONFIG_HOME', config);
  vi.stubEnv('FIELDWORK_NO_UPDATE_NOTICE', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(config, { recursive: true, force: true });
});

const advice = (required: boolean) => ({
  'X-Fieldwork-Cli-Latest': '9.9.9',
  'X-Fieldwork-Cli-Update': required ? 'required' : 'available',
  'X-Fieldwork-Cli-Hint': required
    ? 'Too old. Update with: npm install --global @agentionai/fieldwork-cli@9.9.9'
    : 'fieldwork 9.9.9 is available. Update with: npm install --global @agentionai/fieldwork-cli@9.9.9',
});
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
  );

it('names itself on every request', async () => {
  const fetch = answer(200, []);
  vi.stubGlobal('fetch', fetch);
  await request('http://fieldwork.test', '/campaigns');
  const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
  expect(headers['X-Fieldwork-Client']).toBe(`fieldwork-cli/${CLI_VERSION}`);
});

it('puts "update first" on a failure from a server this version is too old for', async () => {
  vi.stubGlobal(
    'fetch',
    answer(400, { code: 'VALIDATION_ERROR', message: 'Invalid' }, advice(true)),
  );
  await expect(request('http://fieldwork.test', '/runs', 'POST', {})).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
    hint: expect.stringContaining('npm install --global @agentionai/fieldwork-cli@9.9.9'),
    update: { current: CLI_VERSION, latest: '9.9.9', required: true },
  });
});

it('keeps the server’s own hint when an update is only available', async () => {
  vi.stubGlobal(
    'fetch',
    answer(413, { code: 'RECORD_TOO_LARGE', message: 'Big', hint: 'Link the log.' }, advice(false)),
  );
  await expect(request('http://fieldwork.test', '/runs', 'POST', {})).rejects.toMatchObject({
    hint: 'Link the log.',
    update: { latest: '9.9.9', required: false },
  });
});

it('mentions an update once a day on stderr after a success, never on stdout', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', answer(200, [], advice(false)));
  await request('http://fieldwork.test', '/campaigns');
  await request('http://fieldwork.test', '/campaigns');
  expect(errors).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(errors.mock.calls[0]![0]))).toMatchObject({
    notice: 'UPDATE_AVAILABLE',
    latest: '9.9.9',
  });
  expect(logs).not.toHaveBeenCalled();
  // Another server is told separately.
  await request('http://other.test', '/campaigns');
  expect(errors).toHaveBeenCalledTimes(2);
});

it('can be told to keep quiet', async () => {
  vi.stubEnv('FIELDWORK_NO_UPDATE_NOTICE', '1');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', answer(200, [], advice(true)));
  await request('http://fieldwork.test', '/campaigns');
  expect(errors).not.toHaveBeenCalled();
});
