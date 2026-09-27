import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialsPath } from './credentials.js';

/** This CLI's version, from its package: the one `--version` prints and every request names. */
export const CLI_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** What a server said about updating, from the headers it answers an older CLI with. */
export type UpdateAdvice = { current: string; latest: string; required: boolean; hint: string };

export function updateAdvice(headers: Headers): UpdateAdvice | undefined {
  const latest = headers.get('X-Fieldwork-Cli-Latest');
  const hint = headers.get('X-Fieldwork-Cli-Hint');
  if (!latest || !hint) return undefined;
  return {
    current: CLI_VERSION,
    latest,
    required: headers.get('X-Fieldwork-Cli-Update') === 'required',
    hint,
  };
}

const DAY = 24 * 60 * 60 * 1000;

/** Tells whoever runs a command that worked that a newer CLI exists: one JSON line on
 *  stderr, at most once a day per server, so stdout stays exactly the command's result and
 *  a loop of commands is not a loop of notices. A failure always carries the advice in its
 *  own error instead. FIELDWORK_NO_UPDATE_NOTICE=1 silences it. */
export function noticeUpdate(origin: string, advice: UpdateAdvice) {
  if (process.env['FIELDWORK_NO_UPDATE_NOTICE']) return;
  const path = join(dirname(credentialsPath()), 'update-notice.json');
  let seen: Record<string, number> = {};
  try {
    if (existsSync(path)) seen = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
  } catch {
    // A notice is a courtesy: an unreadable record of it means one notice too many.
  }
  if (Date.now() - (seen[origin] ?? 0) < DAY) return;
  console.error(
    JSON.stringify({
      notice: advice.required ? 'UPDATE_REQUIRED' : 'UPDATE_AVAILABLE',
      message: advice.hint,
      current: advice.current,
      latest: advice.latest,
    }),
  );
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...seen, [origin]: Date.now() }));
  } catch {
    // Unwritable config: the notice repeats, which is harmless.
  }
}
