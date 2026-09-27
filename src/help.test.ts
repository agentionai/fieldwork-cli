import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');
const groups: Record<string, string[]> = {
  charts: ['list', 'fields', 'create', 'get', 'data', 'delete'],
  setup: ['campaign'],
  schemas: ['list', 'publish', 'default', 'set-default', 'get', 'template', 'validate', 'extend'],
  products: ['list', 'get', 'create', 'update', 'delete'],
  campaigns: ['list', 'get', 'context', 'create', 'update', 'delete'],
  experiments: ['list', 'get', 'context', 'create', 'update', 'delete'],
  runs: ['list', 'get', 'context', 'create', 'update', 'delete'],
};
function run(cwd: string, args: string[]) {
  return exec(process.execPath, ['--import', loader, main, ...args], {
    cwd,
    env: { ...process.env, FIELDWORK_URL: 'http://127.0.0.1:1' },
  });
}
it('every command help works offline, even with malformed workspace config, on stdout with exit 0', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fieldwork-help-'));
  try {
    mkdirSync(join(cwd, '.fieldwork'));
    writeFileSync(join(cwd, '.fieldwork/workspace.json'), '{broken');
    const paths = [
      [],
      ['context'],
      ...Object.entries(groups).flatMap(([group, commands]) => [
        [group],
        ...commands.map((command) => [group, command]),
      ]),
    ];
    const help = new Map<string, string>();
    for (const args of paths) {
      const response = await run(cwd, [...args, '--help']);
      expect(response.stderr).toBe('');
      expect(response.stdout).toContain(
        `Usage: fieldwork${args.length ? ' ' + args.join(' ') : ''}`,
      );
      help.set(args.join(' '), response.stdout);
    }
    expect(help.get('experiments create')).not.toContain('--experiment');
    expect(help.get('experiments create')).toContain('hypothesis');
    for (const op of ['create', 'update']) {
      expect(help.get(`experiments ${op}`)).toContain('4000 characters');
      expect(help.get(`experiments ${op}`)).toContain('method');
      expect(help.get(`runs ${op}`)).toContain('must be JSON objects');
    }
    expect(help.get('runs create')).toContain('--experiment');
    expect(help.get('runs create')).toContain('title');
    expect(help.get('schemas validate')).toContain('VALIDATION_FAILED');
    expect(help.get('schemas validate')).toContain('experiment varying');
    expect(help.get('schemas publish')).toContain('snake_case');
    expect(help.get('campaigns update')).toContain('revision');
    expect(help.get('schemas list')?.replace(/\s+/g, ' ')).toContain('--inherited');
    const version = await run(cwd, ['--version']);
    expect(version.stderr).toBe('');
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\s*$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

it('common CLI mistakes produce one JSON stderr error with a repair hint and exit 1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fieldwork-errors-'));
  try {
    const cases = [
      { args: ['not-a-command'], code: 'commander.unknownCommand', message: 'unknown command' },
      {
        args: ['runs', 'get'],
        code: 'commander.missingArgument',
        message: 'missing required argument',
      },
      {
        args: ['runs', 'create'],
        code: 'commander.missingMandatoryOptionValue',
        message: '--json',
      },
      {
        args: ['experiments', 'create', '--experiment', 'awq', '--json', '{}'],
        code: 'commander.unknownOption',
        message: '--experiment',
      },
      { args: ['products', 'create', '--json', '{'], code: 'INVALID_JSON', message: 'JSON input' },
      { args: ['products', 'create', '--json', '[]'], code: 'INVALID_JSON', message: 'object' },
      {
        args: ['schemas', 'validate', 'not-a-version', '--json', '{}'],
        code: 'CLIENT_ERROR',
        message: 'version IDs',
      },
      { args: ['experiments', 'list'], code: 'CLIENT_ERROR', message: '--campaign' },
      {
        args: ['runs', 'delete', 'baseline', '--revision', '0'],
        code: 'CLIENT_ERROR',
        message: 'positive integer',
      },
      { args: ['products', 'list'], code: 'NETWORK_ERROR', message: 'Could not reach the server' },
    ];
    for (const entry of cases) {
      const failure = await run(cwd, entry.args).then(
        () => {
          throw new Error(`Expected command failure: ${entry.args.join(' ')}`);
        },
        (e: { code: number; stdout: string; stderr: string }) => e,
      );
      expect(failure.code).toBe(1);
      expect(failure.stdout).toBe('');
      const error = JSON.parse(failure.stderr);
      expect(error.code).toBe(entry.code);
      expect(error.message).toContain(entry.message);
      expect(error.hint.length).toBeGreaterThan(20);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);
