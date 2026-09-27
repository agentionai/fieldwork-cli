import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where the CLI keeps credentials, and how it decides which one to use.
 *
 * Not the workspace. A credential in a project directory gets committed, and the workspace
 * is shared with whoever clones the repository; the point of an agent credential is that it
 * belongs to one machine and one human. It lives under the user's config directory with
 * owner-only permissions instead.
 *
 * Keyed by server origin, so a credential for a staging deployment is never sent to
 * production because it happened to be the last one stored.
 */
export type StoredCredential = { token: string; organization?: string | undefined };
type CredentialFile = { version: 1; servers: Record<string, StoredCredential> };

export function credentialsPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(base, 'fieldwork', 'credentials.json');
}

/** Origins are compared without a trailing slash so http://host and http://host/ agree. */
const key = (url: string) => url.replace(/\/$/, '');

function read(): CredentialFile {
  const path = credentialsPath();
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CredentialFile;
    return parsed?.servers && typeof parsed.servers === 'object'
      ? { version: 1, servers: parsed.servers }
      : { version: 1, servers: {} };
  } catch {
    // A corrupted file must not lock the CLI out: an explicit --token or FIELDWORK_TOKEN
    // still works, and `auth login` overwrites it.
    return { version: 1, servers: {} };
  }
}

export function storedCredential(url: string): StoredCredential | undefined {
  return read().servers[key(url)];
}

export function storeCredential(url: string, credential: StoredCredential): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = read();
  file.servers[key(url)] = credential;
  // Written before chmod, so the window where it exists with default permissions is as
  // small as possible; the directory is already owner-only.
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function forgetCredential(url: string): boolean {
  const file = read();
  if (!file.servers[key(url)]) return false;
  delete file.servers[key(url)];
  const path = credentialsPath();
  if (Object.keys(file.servers).length === 0) rmSync(path, { force: true });
  else {
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return true;
}

export type CredentialSource = 'flag' | 'environment' | 'file' | 'none';

/** Resolution order, matching how --url resolves: explicit, then environment, then stored.
 *  The source is reported so `auth status` can say which one is in play -- the usual
 *  confusion is a stale environment variable shadowing a fresh login. */
export function resolveCredential(
  url: string,
  flags: { token?: string | undefined; org?: string | undefined },
): { token?: string | undefined; organization?: string | undefined; source: CredentialSource } {
  if (flags.token) return { token: flags.token, organization: flags.org, source: 'flag' };
  const fromEnvironment = process.env['FIELDWORK_TOKEN'];
  if (fromEnvironment)
    return {
      token: fromEnvironment,
      organization: flags.org ?? process.env['FIELDWORK_ORGANIZATION'],
      source: 'environment',
    };
  const stored = storedCredential(url);
  if (stored)
    return {
      token: stored.token,
      organization: flags.org ?? process.env['FIELDWORK_ORGANIZATION'] ?? stored.organization,
      source: 'file',
    };
  return {
    organization: flags.org ?? process.env['FIELDWORK_ORGANIZATION'],
    source: 'none',
  };
}
