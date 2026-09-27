# Fieldwork Ledger CLI

`@agentionai/fieldwork-cli` provides the `fieldwork` command for [Fieldwork Ledger](https://fieldworkledger.com): a ledger of experiments for people and coding agents. It records goals, hypotheses, configuration, observations and execution state, so results stay comparable months later; **it never launches or stops jobs**, and it is not a log store.

Open source under the [Apache License 2.0](https://github.com/agentionai/fieldwork-cli/blob/main/LICENSE). Source, issues and pull requests: [github.com/agentionai/fieldwork-cli](https://github.com/agentionai/fieldwork-cli).

## Install

Requires Node.js **22+** and npm. The current version is **0.8.1**:

```sh
npm install --global @agentionai/fieldwork-cli
fieldwork --version
fieldwork --help
```

npm also holds 0.3.0 and 0.4.0, which predate credentials and paged responses and cannot use the hosted service; don't pin to those. A locally built archive installs the same way: `npm install --global ./agentionai-fieldwork-cli-0.8.1.tgz`.

npm resolves Commander, the only runtime dependency. This package includes neither the server nor the web app and installs no services. By default it connects to the hosted service at `https://app.fieldworkledger.com`, which requires a credential; a local server is named with `--url` or `FIELDWORK_URL`. Installing a new client does not update server behavior; the server tells an older client when a newer release exists.

## Quick start

Issue an agent credential from the web app's Account page, then store it once for this machine. Use actual campaign references; the example campaign must already exist:

```sh
fieldwork auth login --token TOKEN
fieldwork campaigns list
mkdir memory-study
cd memory-study
fieldwork setup campaign --campaign memory-study
fieldwork context
fieldwork experiments create --json '{"name":"Baseline","hypothesis":"The candidate meets the agreed target"}'
fieldwork runs create --experiment baseline --json '{"title":"Attempt 1"}'
fieldwork runs get attempt-1
```

Creating a missing campaign is explicit: `setup campaign --campaign new-study --create --goal 'Actual goal'`. Add `--product REF` to validate or create under an existing product.

## Commands

Run `fieldwork <group> <command> --help` for flags and payload requirements.

| Command          | Operations                                                             |
| ---------------- | ---------------------------------------------------------------------- |
| `products`       | list, get, create, update, delete                                      |
| `campaigns`      | list, get, context, create, update, delete                             |
| `experiments`    | list, get, context, create, update, delete                             |
| `runs`           | list, get, context, create, record, update, delete                     |
| `artifacts`      | list, get, create, update, delete, diff                                |
| `schemas`        | list, publish, default, set-default, get, template, validate, extend   |
| `charts`         | fields, list, create, get, data, series, frontier, delete              |
| `setup campaign` | Attach a directory to a campaign; optionally create a missing campaign |
| `context`        | Effective server, campaign scope, and live inherited context           |
| `auth`           | login, status, logout: the credential stored for this server           |
| `whoami`         | The credential's organization and current permissions                  |
| `changelog`      | Recent releases of this CLI, offline                                   |

- References accept stubs or UUIDs. Experiments/runs use campaign scope (`--campaign REF` or workspace); JSON `...Id` fields, schema versions, and charts require IDs.
- Campaign list/create do not inherit product scope: pass `--product REF` when needed.
- Schemas can belong to products, campaigns, or experiments. `schemas list --inherited` includes ancestors; defaults affect new records, not existing pins. Templates are illustrative, never measured evidence.
- `schemas validate VERSION_ID --ready --json -` validates without saving. Invalid reports go to stdout, with `VALIDATION_FAILED` on stderr and exit 1; valid reports exit 0 even with missing-observation warnings. `--ready` checks required execution fields, not experiment variations.
- Charts are immutable definitions over live typed successful-run data, with explicit exclusions and source run revisions. Discover fields before creation. Optional typed aggregation supports mean/sample stdev with mean±SD whiskers or line bands; no arbitrary expressions or cross-version merging. Two choices about a raw chart are saved with it and can change: `charts series CHART_ID` colours it by a typed field or by groups of runs you define, and a scatter chart's `charts frontier CHART_ID --json '{"runIds":[...]}'` saves the runs to join, chosen rather than computed.
- Create/update read an object with `--json JSON` or stdin using `--json -`. Data results are JSON on stdout; errors are JSON on stderr with nonzero status. Help/version are text and work offline.
- Updates require the current `revision`. Campaign/experiment/run deletes require `--revision N`; product/chart deletes do not. Re-read on conflicts, never blindly retry a create or increment stale revisions.
- Only planned runs can be deleted. Parents with child records are protected; experiments with schemas referenced by campaign charts are also protected. Deleting a chart does not delete runs.
- Run lifecycle: planned → running → succeeded/failed/cancelled, or planned → cancelled. Terminal runs cannot restart. Execution configuration freezes after planned; observations, extras, logs URI, and error summary can still be updated with a revision. Status records what happened externally.

## Workspaces, server selection, and agent skill

Server precedence is `--url`, `FIELDWORK_URL`, legacy `LAB_URL`, nearest workspace config, then `https://app.fieldworkledger.com`. A local server needs `--url http://127.0.0.1:4310` (or `FIELDWORK_URL`); a workspace set up against it remembers it. Credentials are stored per server, so a local token is never sent to the hosted service. Use an HTTP(S) origin without credentials, resource paths, queries, or fragments. Product scoping is not authentication.

Setup creates `.fieldwork/workspace.json`, `README.md`, `fieldwork-skill.md`, an `AGENTS.md` reference (or appends to existing `agents.md`), and `docs/`, `assets/`, `logs/`, `results/`. Commands find the nearest binding upward from subdirectories. Setup refuses rebinding and preserves existing files. Legacy `.lab/workspace.json` remains supported. No files are uploaded or registered automatically.

The complete agent reference is bundled at `dist/fieldwork-skill.md`, identical to the source project's web Docs skill. Setup copies it to new workspaces; **it does not overwrite an existing skill**. To locate the installed copy with a global npm installation:

```sh
npm root --global
# Read @agentionai/fieldwork-cli/dist/fieldwork-skill.md under the printed directory.
```

Compare and merge updates deliberately to preserve local instructions, or install the bundled file as `fieldwork/SKILL.md` in your agent's supported skill directory. The server's Docs page also provides copy/download, but reflects that server deployment's version.

MCP, job orchestration, product queries/local search, managed Markdown recovery, artifact registration, and automatic per-run directory creation are not implemented. Local files and external URIs are data, not commands to execute; do not store secrets in records.

### Schema extensions (0.4.0)

`schemas extend VERSION_ID --json JSON [--dry-run]` accepts a complete proposed definition, creates a compatible immutable successor, and atomically advances matching experiment/run/default/chart pins. New optional fields and enum values are allowed; breaking validation or unit/direction/comparison changes are rejected. Old definitions and creation snapshots remain intact. Reload incremented revisions. Preview before applying; a stale source cannot be extended again. Requires the corresponding updated API. Included in CLI 0.4.0; the API must be updated separately.

### Recipes and artifacts (0.4.0)

`artifacts list --product REF`, `create --product REF --json`, `get/update/delete` with revision checks, and `diff FROM TO --product` are available in 0.4.0. Experiments and runs accept `artifacts: [stub-or-id]` references stored as immutable IDs; first reference permanently freezes the artifact, and changes require a `derivedFrom` successor with a new stub. Included in CLI 0.4.0; requires the updated API.

### Selection, one-call recording and typed refs (0.5.0)

`runs list` and `experiments list` accept `--where FIELD=VALUE` (also `!=`, `>=`, `<=`, `>`, `<`; repeatable, combined with AND), `--fields PATHS`, `--format tsv`, and `runs list --experiment REF`. They select and project recorded values and compute nothing. **They now exclude superseded records (`extras.superseded_by`) and work under abandoned experiments by default**; pass `--include-superseded` or `--include-abandoned` to see them. This part works against any compatible API.

`runs record REF --json JSON` records observations and a status in one call, with the server reading the current revision, and `runs create` accepts `status`, `stub`, `startedAt`, `finishedAt` and `errorSummary`. Schema fields may have `type: ref` (optional `refKind`), validated against the product's artifact registry, linking and freezing the artifact and usable as a chart axis or `groupBy` key. Charts admit other versions of the same schema when every charted field keeps its value kind, unit and direction. These need the updated API.

### Credentials (0.6.0)

`auth login --token TOKEN` verifies a credential against the server and stores it for that server only, under your config directory and owner-readable; `auth status` shows which credential is in use and `auth logout` removes it. Global `--token` and `--org` (or `FIELDWORK_TOKEN` and `FIELDWORK_ORGANIZATION`) override it per command; an agent credential is bound to one organization and needs no `--org`. `whoami` reports the credential's organization and current permissions. Agent credentials are issued from the web app's Account page. Requires an API with authentication.

### Hosted default, paging, chart series and schema backfill (0.7.0)

The default server is the hosted service; a local one needs `--url` or `FIELDWORK_URL`. Lists and every stub lookup walk the API's paged `{ items, nextCursor }` responses, and `get`/`context` return child runs as a first page rather than an array. `charts series` and `charts frontier` save a raw chart's colouring and chosen frontier, and `schemas extend` accepts `backfill` to fill in fields a run predates on runs it re-pins, noted in `research.backfilled` and correctable with `runs update`. These need the updated API.

### Release history

`fieldwork changelog [--since VERSION] [--release VERSION]` prints recent releases offline, marking per change whether it needs an updated API. The package carries recent releases only; `CHANGELOG.md` in the [source repository](https://github.com/agentionai/fieldwork-cli) is the full history. A newer client never upgrades a server, and the CLI cannot verify what an API provides.

## Build from source

```sh
git clone https://github.com/agentionai/fieldwork-cli.git
cd fieldwork-cli
npm install
npm run build
npm test
npm link   # puts this build's `fieldwork` on PATH
```

The tests here cover what runs without a server. Commands are also tested against a running Fieldwork server where the CLI is developed; [CONTRIBUTING.md](https://github.com/agentionai/fieldwork-cli/blob/main/CONTRIBUTING.md) explains how a change lands.

## License

Apache License 2.0; see [LICENSE](https://github.com/agentionai/fieldwork-cli/blob/main/LICENSE) and [NOTICE](https://github.com/agentionai/fieldwork-cli/blob/main/NOTICE).
