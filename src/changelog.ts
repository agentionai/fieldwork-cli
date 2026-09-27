// Recent releases only. The package deliberately does not carry the whole history: when adding a
// release, prepend it here, drop the oldest, and keep CHANGELOG.md as the complete record.
// `requiresApi` is per change because one release can mix client-only and server-dependent work.
// It states what a version needs; the CLI cannot and does not attest what a server actually has.
export interface ChangelogChange {
  summary: string;
  requiresApi: boolean;
}
export interface ChangelogEntry {
  version: string;
  date: string;
  status: 'published' | 'prepared';
  changes: ChangelogChange[];
}
export const fullHistory = 'CHANGELOG.md at https://github.com/agentionai/fieldwork-cli';
export const entries: readonly ChangelogEntry[] = [
  {
    version: '0.8.1',
    date: '2026-09-27',
    status: 'prepared',
    changes: [
      {
        summary:
          'Open source under the Apache License 2.0, at https://github.com/agentionai/fieldwork-cli. The package carries the license and links its repository; the full changelog is there. No change in behaviour.',
        requiresApi: false,
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-26',
    status: 'published',
    changes: [
      {
        summary:
          "Every request names the CLI's version. When the server says a newer release exists, a command that works prints one UPDATE_AVAILABLE notice on stderr, at most once a day per server (FIELDWORK_NO_UPDATE_NOTICE=1 silences it); a failure's error carries an update object, and says to update first when this version is too old.",
        requiresApi: true,
      },
      {
        summary:
          "A refusal's own hint from the server -- over a limit, a plan limit, a deletion needing confirmation -- is shown as the hint. Help says Fieldwork is a ledger of experiments, not a log store.",
        requiresApi: false,
      },
      {
        summary:
          'runs backfill REF fills in a parameter or comparison-context field a run left empty, finished runs included, once: never over a recorded value, never observations. schemas extend backfill fills forgotten fields too.',
        requiresApi: true,
      },
      {
        summary:
          'products, campaigns and experiments gain archive and restore; experiments list --include-archived; stubs of archived records still resolve. delete takes --confirm NAME when the unit holds work, which is deleted with it.',
        requiresApi: true,
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-09-22',
    status: 'published',
    changes: [
      {
        summary:
          'The default server is the hosted service, https://app.fieldworkledger.com, instead of http://127.0.0.1:4310. A local server needs --url or FIELDWORK_URL; a workspace set up against one keeps using it.',
        requiresApi: false,
      },
      {
        summary:
          'Experiment and run lists, and every stub lookup behind get, record, update and delete, walk the paged { items, nextCursor } responses. 0.6.0 read the first page shape as an invalid collection against a current server.',
        requiresApi: true,
      },
      {
        summary:
          'charts frontier CHART_ID --json {"runIds":[...]} saves the runs a scatter chart joins as its frontier, replacing any earlier choice. Chosen, never computed; only runs the chart plots are accepted.',
        requiresApi: true,
      },
      {
        summary:
          'charts series CHART_ID --json {"series":...} colours a raw chart by a typed field, or by groups of runs you define (for a split no field records, such as ours against as shipped); null restores comparison-context series. charts create accepts series too.',
        requiresApi: true,
      },
      {
        summary:
          'schemas extend accepts backfill: {field: {RUN_ID: value}} to fill in parameter or context fields a run predates -- added after it was recorded, by this extension or an earlier one -- finished runs included. Runs note them in research.backfilled, and a backfilled value can be corrected with runs update.',
        requiresApi: true,
      },
    ],
  },
];
function order(version: string): number[] {
  return version.split('.').map(Number);
}
export function compareVersions(a: string, b: string): number {
  const [left, right] = [order(a), order(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function invalid(message: string, hint: string): never {
  throw Object.assign(new Error(message), { code: 'UNKNOWN_VERSION', hint });
}
export function selectChangelog(
  cliVersion: string,
  options: { since?: string; release?: string } = {},
) {
  const oldest = entries[entries.length - 1]!.version;
  for (const value of [options.since, options.release]) {
    if (value !== undefined && !/^\d+(\.\d+)*$/.test(value))
      invalid(`Not a version number: ${value}`, 'Use a dotted version such as 0.4.0.');
  }
  let selected = [...entries];
  if (options.release) {
    selected = selected.filter((entry) => entry.version === options.release);
    if (!selected.length)
      invalid(
        `Release ${options.release} is not bundled with this CLI`,
        `This package carries recent releases only, back to ${oldest}. See ${fullHistory}.`,
      );
  }
  if (options.since)
    selected = selected.filter((entry) => compareVersions(entry.version, options.since!) > 0);
  // An older --since must not read as "nothing else ever changed".
  const truncated =
    !options.release && !!options.since && compareVersions(options.since, oldest) < 0;
  return {
    cliVersion,
    recentOnly: true,
    oldestBundled: oldest,
    fullHistory,
    ...(truncated ? { truncated: true } : {}),
    note: `Recent releases only, back to ${oldest}${truncated ? `; changes before ${oldest} are not bundled` : ''}. requiresApi states what a change needs from the server, which this CLI cannot verify: a newer client does not upgrade an API.`,
    entries: selected,
  };
}
