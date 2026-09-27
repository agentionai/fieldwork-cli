# Fieldwork CLI changelog

Complete history for `@agentionai/fieldwork-cli`. The package itself carries only recent releases, printed by `fieldwork changelog`; this file is the full record and is not shipped. When preparing a release, add it here and to `src/changelog.ts`, dropping the oldest bundled entry so the package does not accumulate a history.

"Requires an updated API" means the change depends on server behaviour from the corresponding source baseline. There is no compatibility handshake: installing a newer client never upgrades a server, and the CLI cannot verify what an API provides.

## 0.8.1 — 2026-09-27 (prepared, not published)

Client only:

- Open source under the [Apache License 2.0](LICENSE). The source is at https://github.com/agentionai/fieldwork-cli, and the package links it as its repository, homepage and issue tracker. This file, the complete history, moved there. No change in behaviour.

## 0.8.0 — 2026-09-26 (published to npm 2026-09-27)

Client only:

- A refusal's own `hint` from the server -- over a limit, say -- is shown in place of the generic one.
- Every request names the CLI's version (`X-Fieldwork-Client`). When the server says a newer release exists, a successful command prints one `UPDATE_AVAILABLE` notice on stderr, at most once a day per server (`FIELDWORK_NO_UPDATE_NOTICE=1` silences it), and a failure's error carries an `update` object -- with "update first" as its hint when the server says this version is too old. Stdout is unchanged.
- Help says what Fieldwork is for: a ledger of experiments, not a log store. `runs create` and `runs record` point logs at `logsUri`, and say a run's data is limited by plan.

Requires an updated API:

- `runs backfill REF --json '{"comparisonContext":{"git_commit":"a1b2c3d"}}'` fills in a parameter or comparison-context field a run left empty, finished runs included, once. Never over a recorded value; never observations; a field the schema does not declare is added with `schemas extend`. Each value notes when and by whom.
- `schemas extend` backfill also fills fields a run was recorded with but left empty, not only fields it predates.
- `products|campaigns|experiments archive REF` and `restore REF` file work away and bring it back; `experiments list --include-archived` shows it. Stubs of archived records still resolve.
- `products|campaigns|experiments delete` take `--confirm NAME`, needed when the unit holds work, which is deleted with it. `products delete` no longer requires the product to be empty.

## 0.7.0 — 2026-09-22 (published to npm 2026-09-24)

Client only:

- **Behaviour change:** the default server is the hosted service, `https://app.fieldworkledger.com`, instead of `http://127.0.0.1:4310`. A local server needs `--url` or `FIELDWORK_URL`; a workspace set up against one keeps using it. Credentials stay keyed by server, so a local token is never sent to the hosted service.

Requires an updated API:

- `experiments list`, `runs list`, and the stub lookups behind `get`, `context`, `record`, `update` and `delete` walk the paged `{ items, nextCursor }` responses. 0.6.0 rejected the paged shape as an invalid record collection, so every one of those commands failed against a current server. `get`/`context` results carry their child `runs` (and a campaign's `experiments`) as a first page, `{ items, nextCursor }`, rather than an array.
- `charts frontier CHART_ID --json '{"runIds":[...]}'` saves the runs a scatter chart joins as its frontier, replacing any earlier choice; `[]` clears it. The frontier is chosen, never computed, and only runs the chart currently plots are accepted.
- `charts series CHART_ID --json '{"series":...}'` chooses what a raw chart's colours mean: a typed field (`{"by":"field","section":"parameters","field":"recipe_family"}`), or groups of runs you define (`{"by":"groups","groups":[{"label":"Ours","runIds":[...]}],"otherLabel":"Shipped"}`) for a split no single field records. `null` restores one series per comparison context, and every point still reports its context. `charts create` accepts `series` as well.
- `schemas extend --json '{"definition":{...},"backfill":{"packager":{"RUN_ID":"unsloth"}}}'` fills in parameter or comparison-context fields a run predates -- added to the schema after the run was recorded, by this extension or an earlier one -- on runs it re-pins, finished runs included, whose configuration is otherwise frozen. Never over a recorded value, validated and applied in the same atomic re-pin; a run recorded after the field existed keeps its empty value. Runs record them in `research.backfilled`, and a backfilled value stays correctable with `runs update`; everything a run executed with stays frozen.

Agent credentials are now issued from the web app's Account page, and `auth login --token` accepts them.

## 0.6.0 — 2026-09-20 (prepared, not published)

Client only:

- `fieldwork auth login --token TOKEN [--org ID]`, `fieldwork auth status` and `fieldwork auth logout` keep one credential per server under your config directory (`$XDG_CONFIG_HOME/fieldwork/credentials.json`, or `~/.config`), owner-readable only. Ordinary commands then need no `--token`. It is deliberately not stored in the workspace: that directory is shared with whoever clones the repository, and a credential belongs to one machine and one human.
- `auth login` verifies the credential against the server before storing it, so a mistyped token fails at the paste rather than on some later command. `auth status` reports which source is in use — flag, environment, or stored file — because a stale `FIELDWORK_TOKEN` shadowing a fresh login is the usual confusion. `auth logout` is idempotent.

Requires an updated API:

- Global `--token` and `--org` send a credential and an organization with every request, defaulting to `FIELDWORK_TOKEN` and `FIELDWORK_ORGANIZATION`. An agent credential is bound to one organization at issue time, so `--org` is unnecessary for one. A server that requires no credential ignores both.
- Authentication failures explain themselves: `401` reports a missing credential and `403` the wrong organization or a withdrawn grant, each stating that retrying will not help.

Note: at 0.6.0 no server issued agent credentials yet, so these commands accepted any token the server accepted. Issuance arrived with the web app's Account page; see 0.7.0.

Packaging: `dist/credentials.js` joins the published file list.

## 0.5.0 — 2026-09-18 (prepared, not published)

Client only:

- `runs list` and `experiments list` select and project rows: `--where FIELD=VALUE` (also `!=`, `>=`, `<=`, `>`, `<`, repeatable and combined with AND), `--fields PATHS`, `--format tsv`, and `runs list --experiment REF`. The tool selects and projects recorded values and computes nothing.
- **Behaviour change:** those lists now exclude superseded records (`extras.superseded_by`) and work under abandoned experiments by default. `--include-superseded` and `--include-abandoned` restore them. Scripts that relied on the previous output must pass the flags.
- `fieldwork changelog [--since VERSION] [--release VERSION]` reports recent releases offline.
- Network failures, 15-second timeouts, and invalid server responses have distinct machine-readable error codes and retry guidance. Structured API failures retain the server request ID for support correlation.

Requires an updated API:

- `runs record REF` applies observations, extras, comparison context, artifacts, a status, an error summary or a logs URI in one call. The server reads the current revision, a result may be recorded directly from `planned`, and replaying identical revisionless JSON returns the committed record without another revision.
- `runs create` accepts `status`, `stub`, `startedAt`, `finishedAt` and `errorSummary`, so a finished or historical run is a single call. Dates are order-checked and never invented.
- Schema fields support `type: ref` with optional `refKind` of `recipe` or `file`, validated against the product's artifact registry. A recorded ref links and freezes its artifact into `research.artifactIds` and works as a bar X axis and `groupBy` key.
- Charts admit runs pinned to other versions of the same schema when every charted field keeps its value kind, unit and direction. `schemaVersions: "pinned"` opts out, and `charts data` reports every candidate version with its verdict.
- `charts data` leaves runs marked `extras.superseded_by` out of both `points` and `aggregates`, reporting each under `excluded` with the replacement named in the reason. The client-side exclusion in `runs list` now has a server-side counterpart for computed chart output; raw HTTP collections still return every record. Aggregated charts are the reason this matters: a pooled run is a weighted average of the per-set runs beside it, so charting both inflates n and understates every error bar.
- Experiment and run responses repeat `schemaVersionId`, `varying`, `observations`, `comparisonContext`, `extras` and `artifactIds` at the top level; `research` remains canonical.

Packaging: `dist/select.js` and `dist/changelog.js` join the published file list, and the release check now covers `runs record`, `changelog` and the changelog's own contents.

## 0.4.0 — 2026-09-17 (published)

Requires an updated API:

- `artifacts` group: `list`, `create`, `get`, `update`, `delete` and `diff` for product-scoped recipes and file metadata. Experiments and runs accept an `artifacts` reference array stored as immutable IDs; the first reference permanently freezes the artifact.
- `schemas extend VERSION_ID --json JSON [--dry-run]` publishes a compatible successor and atomically re-pins matching experiments, runs, defaults and charts.

Client only:

- Updated bundled agent skill and CLI reference.

0.4.0 is on the npm registry, published on 2026-09-17. It predates 0.5.0's CLI work, credentials and paged responses, so it cannot use the hosted service; install a later version pinned explicitly.

## 0.3.0 — 2026-09-17 (published)

On the npm registry, published on 2026-09-17. Baseline command surface, reconstructed from the prepared archive: `products`, `campaigns`, `experiments`, `runs`, `schemas`, `charts`, `setup campaign` and `context`, with stub-first references, revision-checked updates, campaign workspace setup and the bundled agent skill.

Releases before 0.3.0 are not recorded; no archive or release note survives for them.
