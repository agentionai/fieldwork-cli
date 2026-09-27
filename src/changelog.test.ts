import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compareVersions, entries, selectChangelog } from './changelog.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

it('bundles a recent window that still leads with the version being shipped', () => {
  expect(entries[0]!.version).toBe(manifest.version);
  expect(entries.length).toBeLessThanOrEqual(3);
  expect(entries.map((entry) => entry.version)).toEqual(
    [...entries]
      .sort((a, b) => compareVersions(b.version, a.version))
      .map((entry) => entry.version),
  );
  for (const entry of entries) {
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.changes.length).toBeGreaterThan(0);
  }
});

it('says it is a window rather than the whole history, and where the rest lives', () => {
  const all = selectChangelog(manifest.version);
  expect(all).toMatchObject({
    cliVersion: manifest.version,
    recentOnly: true,
    oldestBundled: entries[entries.length - 1]!.version,
  });
  expect(all.fullHistory).toContain('CHANGELOG.md');
  expect(all.truncated).toBeUndefined();
  expect(all.entries).toHaveLength(entries.length);
  const older = selectChangelog(manifest.version, { since: '0.1.0' });
  expect(older.truncated).toBe(true);
  expect(older.note).toContain('not bundled');
});

it('marks per change whether an updated API is needed, without claiming to know the server', () => {
  // Across what is bundled: one release can be client-only, but the window shows both kinds.
  const changes = entries.flatMap((entry) => entry.changes);
  expect(changes.some((change) => change.requiresApi)).toBe(true);
  expect(changes.some((change) => !change.requiresApi)).toBe(true);
  expect(selectChangelog(manifest.version).note).toContain('cannot verify');
});

it('filters by version and refuses one it does not carry', () => {
  expect(selectChangelog(manifest.version, { release: manifest.version }).entries).toHaveLength(1);
  expect(selectChangelog(manifest.version, { since: manifest.version }).entries).toEqual([]);
  expect(
    selectChangelog(manifest.version, { since: entries[entries.length - 1]!.version }).entries
      .length,
  ).toBe(entries.length - 1);
  for (const bad of [{ release: '0.0.1' }, { release: 'latest' }, { since: 'v1' }]) {
    expect(() => selectChangelog(manifest.version, bad)).toThrow();
  }
  expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  expect(compareVersions('1.0', '1.0.0')).toBe(0);
});

it('keeps every bundled release in the complete repository history', () => {
  const history = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  for (const entry of entries) expect(history).toContain(`## ${entry.version} — ${entry.date}`);
});
