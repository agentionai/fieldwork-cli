#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { request, requestAll } from './client.js';
import { CLI_VERSION } from './version.js';
import { DEFAULT_SERVER, Scope, setupCampaign } from './workspace.js';
import { filterRows, parseCondition, projectRows, resolve, toTsv, type Row } from './select.js';
import { selectChangelog } from './changelog.js';
import {
  credentialsPath,
  forgetCredential,
  resolveCredential,
  storeCredential,
} from './credentials.js';

const version = CLI_VERSION;
const program = new Command()
  .name('fieldwork')
  .description('Fieldwork API client; JSON results on stdout, JSON failures on stderr')
  .version(version)
  .option(
    '--url <url>',
    `API server URL (defaults to FIELDWORK_URL, LAB_URL, workspace config, then ${DEFAULT_SERVER})`,
  )
  .option('--token <token>', 'API credential (defaults to FIELDWORK_TOKEN)')
  .option(
    '--org <id>',
    'Organization to act in (defaults to FIELDWORK_ORGANIZATION); unnecessary for a credential bound to one organization',
  );
program.exitOverride();
program.configureOutput({ writeErr: () => {} });
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
/** Credentials resolve like --url does: explicit flag, then environment, then the stored
 *  credential for this server. Deliberately no prompt fallback -- a secret typed at a
 *  prompt ends up in shell history. */
const credentials = () => {
  const options = program.opts<{ token?: string; org?: string }>();
  // serverUrl(), not url(): url() builds a Scope that carries credentials, and asking for
  // credentials to resolve credentials recurses until the stack gives out.
  const { token, organization } = resolveCredential(serverUrl(), {
    token: options.token,
    org: options.org,
  });
  return { token, organization };
};
const send = (path: string, method?: string, body?: unknown) =>
  request(url(), path, method, body, credentials()).then(output);
function input(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value === '-' ? readFileSync(0, 'utf8') : value);
  } catch (error) {
    throw Object.assign(new Error(`Cannot read JSON input: ${(error as Error).message}`), {
      code: 'INVALID_JSON',
      hint: 'Supply a valid JSON object with --json, or use --json - to read it from stdin; quote keys and strings with double quotes.',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Object.assign(new Error('JSON input must be an object'), {
      code: 'INVALID_JSON',
      hint: 'Use a JSON object such as {"name":"Example"}, not null, an array, or a scalar; see the command’s --help for required fields.',
    });
  return parsed as Record<string, unknown>;
}
function fail(message: string): never {
  throw new Error(message);
}
/** Server resolution alone, with no credentials, so credential resolution can use it. */
const serverUrl = () => new Scope(program.opts<{ url?: string }>().url).url;
/** One scope per invocation, carrying both the resolved server and the credentials, so no
 *  call site can reach the API without them. */
const apiScope = () =>
  new Scope(program.opts<{ url?: string }>().url, process.cwd(), credentials());
const url = () => serverUrl();
const path = (id: string) => `/campaigns/${encodeURIComponent(id)}`;
const collection = (product?: string) =>
  product ? `/products/${encodeURIComponent(product)}/campaigns` : '/campaigns';
const auth = program.command('auth').description('Manage the API credential for this machine');
auth
  .command('login')
  .description('Store a credential for this server')
  .action(async () => {
    const options = program.opts<{ token?: string; org?: string }>();
    // --token and --org are global, so they are spelled the same here as everywhere else.
    // Declaring them again on this subcommand shadowed the global ones and made login the
    // one command that could not see its own credential.
    if (!options.token)
      throw Object.assign(new Error('auth login requires --token'), {
        code: 'MISSING_TOKEN',
        hint: 'Pass the credential with --token. It is stored for this server only, under your config directory.',
      });
    const server = url();
    // Verified before it is written. Storing an unusable credential turns a typo into a
    // failure on some later command, far from the paste that caused it.
    const organizations = (await request(server, '/organizations', 'GET', undefined, {
      token: options.token,
      organization: options.org,
    })) as { id: string; name: string }[];
    const chosen = options.org ?? (organizations.length === 1 ? organizations[0]?.id : undefined);
    const path = storeCredential(server, {
      token: options.token,
      ...(chosen ? { organization: chosen } : {}),
    });
    output({
      server,
      storedAt: path,
      organizations,
      organization: chosen ?? null,
      // Several organizations and no --org means later commands need one; say so now
      // rather than letting every request fail with a permission error.
      ...(chosen
        ? {}
        : {
            note: 'Several organizations are available; pass --org, or set FIELDWORK_ORGANIZATION.',
          }),
    });
  });
auth
  .command('status')
  .description('Show which credential this server would use, and whether it works')
  .action(async () => {
    const server = url();
    const resolved = resolveCredential(server, program.opts<{ token?: string; org?: string }>());
    if (!resolved.token)
      return output({
        server,
        source: 'none',
        credentialsFile: credentialsPath(),
        note: 'No credential. Use fieldwork auth login --token, or set FIELDWORK_TOKEN.',
      });
    const organizations = (await request(server, '/organizations', 'GET', undefined, resolved)) as {
      id: string;
      name: string;
    }[];
    output({
      server,
      // Which source is in play matters: a stale FIELDWORK_TOKEN silently shadowing a
      // fresh login is the usual confusion.
      source: resolved.source,
      credentialsFile: credentialsPath(),
      organization: resolved.organization ?? null,
      organizations,
    });
  });
auth
  .command('logout')
  .description('Remove the stored credential for this server')
  .action(() => {
    const server = url();
    // Reports what it did rather than failing when there was nothing stored: logging out
    // twice is not an error, and an environment variable is not ours to unset.
    output({ server, removed: forgetCredential(server), credentialsFile: credentialsPath() });
  });

const setup = program
  .command('setup')
  .description('Attach the current directory to an existing campaign');
setup
  .command('campaign')
  .description(
    'Create local config and workspace directories; use --create to add a missing campaign',
  )
  .requiredOption('--campaign <ref>', 'Campaign stub or ID')
  .option('--product <ref>', 'Product stub or ID; validates parentage')
  .option('--create', 'Create the campaign when not found; requires --goal')
  .option('--goal <text>', 'Goal for --create')
  .action(
    async (options: { campaign: string; product?: string; create?: boolean; goal?: string }) => {
      const result = await setupCampaign(
        url(),
        { ...options, campaign: options.campaign },
        process.cwd(),
        credentials(),
      );
      output({
        workspaceRoot: result.root,
        created: result.created,
        product: result.config.product,
        campaign: result.config.campaign,
      });
    },
  );
program
  .command('context')
  .description(
    'Effective server, workspace scope, and live inherited research context (setup campaign required when no scope is given)',
  )
  .option('--campaign <ref>', 'Inspect without a local workspace')
  .action(async (options: { campaign?: string }) =>
    output(await apiScope().context(options.campaign)),
  );
program
  .command('changelog')
  .description(
    'Recent releases of this CLI, offline; each change states whether it needs an updated API',
  )
  .option('--since <version>', 'Only releases after this version')
  .option('--release <version>', 'Only this release')
  .addHelpText(
    'after',
    '\nThe package carries recent releases only; see the repository changelog for the full history.\nrequiresApi records what a change needs from the server. The CLI cannot verify what an API\nprovides, and installing a newer client never upgrades a server.',
  )
  .action((options: { since?: string; release?: string }) =>
    output(selectChangelog(version, options)),
  );
const campaigns = program
  .command('campaigns')
  .description('Manage research goals and inspect inherited product context');
campaigns
  .command('list')
  .option('--product <ref>', 'Scope to product (stub or ID) via /products/:id/campaigns')
  .description('List campaigns; omit product for the whole workspace')
  .action(async (options: { product?: string }) =>
    send(collection(options.product && (await apiScope().product(options.product)).id)),
  );
campaigns
  .command('get')
  .argument('<ref>')
  .description('Get campaign by stub or ID, with live parent context and runs')
  .action(async (reference: string) => send(path((await apiScope().campaign(reference)).id)));
campaigns
  .command('context')
  .argument('<ref>')
  .description(
    'Get campaign goal, criteria, constraints and inherited context (same complete response as get)',
  )
  .action(async (reference: string) => send(path((await apiScope().campaign(reference)).id)));
campaigns
  .command('create')
  .option(
    '--product <ref>',
    'Product (stub or ID) in the URL; omit for independent campaigns or a productId in JSON',
  )
  .requiredOption('--json <json|->', 'JSON object, or - to read stdin; requires name and goal')
  .action(async (options: { json: string; product?: string }) =>
    send(
      collection(options.product && (await apiScope().product(options.product)).id),
      'POST',
      input(options.json),
    ),
  );
campaigns
  .command('update')
  .argument('<ref>')
  .requiredOption('--json <json|->', 'Patch including expected revision')
  .description('Patch by stub or ID; JSON includes expected revision')
  .action(async (reference: string, options: { json: string }) =>
    send(path((await apiScope().campaign(reference)).id), 'PATCH', input(options.json)),
  );
campaigns
  .command('delete')
  .argument('<ref>')
  .requiredOption('--revision <number>', 'Expected revision')
  .option(
    '--confirm <name>',
    'The campaign name, required when it holds work: everything in it is deleted too',
  )
  .description(
    'Delete a campaign and everything in it, for good. To keep the work out of the way instead, use archive',
  )
  .action(async (reference: string, options: { revision: string; confirm?: string }) => {
    const revision = Number(options.revision);
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error('Revision must be a positive integer');
    return send(path((await apiScope().campaign(reference)).id), 'DELETE', {
      revision,
      ...(options.confirm ? { confirm: options.confirm } : {}),
    });
  });
const artifacts = program
  .command('artifacts')
  .description('Product-scoped recipes and file metadata; permanently immutable after reference');
const artifactProduct = async (ref: string) => (await apiScope().product(ref)).id;
async function artifactRef(ref: string, product?: string) {
  if (/^[0-9a-f-]{36}$/i.test(ref) && !product) return ref;
  if (!product) fail('Artifact stubs require --product REF; IDs can be used directly');
  const values = (await request(
    url(),
    `/products/${encodeURIComponent(await artifactProduct(product!))}/artifacts`,
    'GET',
    undefined,
    credentials(),
  )) as { id: string; stub: string }[];
  const value = values.find((v) => v.id === ref || v.stub === ref);
  if (!value) fail('Artifact not found in product');
  return value!.id;
}
artifacts
  .command('list')
  .requiredOption('--product <ref>', 'Product stub or ID')
  .action(async (o: { product: string }) =>
    send(`/products/${encodeURIComponent(await artifactProduct(o.product))}/artifacts`),
  );
artifacts
  .command('create')
  .requiredOption('--product <ref>', 'Product stub or ID')
  .requiredOption(
    '--json <json|->',
    'Requires stub/name; optional kind, description, definition object, files [{role,uri,sha256?}], derivedFrom ID',
  )
  .action(async (o: { product: string; json: string }) =>
    send(
      `/products/${encodeURIComponent(await artifactProduct(o.product))}/artifacts`,
      'POST',
      input(o.json),
    ),
  );
artifacts
  .command('get')
  .argument('<ref>')
  .option('--product <ref>', 'Required for artifact stubs')
  .action(async (ref: string, o: { product?: string }) =>
    send(`/artifacts/${encodeURIComponent(await artifactRef(ref, o.product))}`),
  );
artifacts
  .command('update')
  .argument('<ref>')
  .option('--product <ref>', 'Required for artifact stubs')
  .requiredOption(
    '--json <json|->',
    'Patch with current revision; definition/files replace whole fields; frozen artifacts reject edits',
  )
  .action(async (ref: string, o: { product?: string; json: string }) =>
    send(
      `/artifacts/${encodeURIComponent(await artifactRef(ref, o.product))}`,
      'PATCH',
      input(o.json),
    ),
  );
artifacts
  .command('delete')
  .argument('<ref>')
  .option('--product <ref>', 'Required for artifact stubs')
  .requiredOption(
    '--revision <number>',
    'Expected revision; referenced artifacts cannot be deleted',
  )
  .action(async (ref: string, o: { product?: string; revision: string }) => {
    const revision = Number(o.revision);
    if (!Number.isSafeInteger(revision) || revision < 1)
      fail('Revision must be a positive integer');
    return send(`/artifacts/${encodeURIComponent(await artifactRef(ref, o.product))}`, 'DELETE', {
      revision,
    });
  });
artifacts
  .command('diff')
  .argument('<from>')
  .argument('<to>')
  .option('--product <ref>', 'Required for artifact stubs')
  .description('Compare recipe definitions/files within one product; paths use JSON Pointer')
  .action(async (from: string, to: string, o: { product?: string }) =>
    send(
      `/artifacts/${encodeURIComponent(await artifactRef(from, o.product))}/diff/${encodeURIComponent(await artifactRef(to, o.product))}`,
    ),
  );
const resolveSchema = async (ref: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(ref))
    fail('Schema references are version IDs; use schemas list --product REF to obtain one');
  return ref;
};
const schemas = program
  .command('schemas')
  .description(
    'Manage typed research schemas: publish immutable versions, inspect templates, and validate payloads before writing records',
  );
type SchemaScopeOptions = {
  product?: string;
  campaign?: string;
  experiment?: string;
  json?: string;
  inherited?: boolean;
};
async function schemaScope(options: SchemaScopeOptions) {
  const scope = apiScope();
  if (options.product) {
    if (options.campaign || options.experiment)
      fail('--product cannot be combined with --campaign or --experiment for schemas');
    return `/products/${encodeURIComponent((await scope.product(options.product)).id)}`;
  }
  const campaign = await scope.campaign(options.campaign);
  return options.experiment
    ? `/experiments/${encodeURIComponent(await scope.work('experiments', options.experiment, campaign.id))}`
    : path(campaign.id);
}
for (const operation of ['list', 'publish', 'default', 'set-default'] as const) {
  const command = schemas
    .command(operation)
    .option('--product <ref>', 'Product scope; cannot combine with campaign/experiment')
    .option('--campaign <ref>', 'Campaign scope; defaults to workspace')
    .option('--experiment <ref>', 'Experiment within campaign');
  if (operation === 'list') command.option('--inherited', 'Include schemas owned by ancestors');
  if (operation === 'publish' || operation === 'set-default')
    command.requiredOption(
      '--json <json|->',
      operation === 'publish'
        ? 'JSON with stub, version, definition; - reads stdin'
        : 'JSON with schemaVersionId and current default revision; null clears product/campaign default',
    );
  command
    .description(
      operation === 'default'
        ? 'Inspect local and effective schema default; no changes to existing records'
        : operation === 'set-default'
          ? 'Set a product/campaign default or pin an experiment (immutable once runs exist)'
          : operation === 'list'
            ? 'List local schemas; --inherited includes ancestors'
            : 'Publish an immutable schema owned by product, campaign or experiment',
    )
    .action(async (options: SchemaScopeOptions) => {
      const target = await schemaScope(options);
      if (operation === 'set-default')
        return send(
          options.experiment ? target : `${target}/schema-default`,
          options.experiment ? 'PATCH' : 'PUT',
          input(options.json!),
        );
      return send(
        `${target}/${operation === 'default' ? 'schema-default' : 'schemas'}${operation === 'list' && options.inherited ? '?inherited=true' : ''}`,
        operation === 'publish' ? 'POST' : 'GET',
        operation === 'publish' ? input(options.json!) : undefined,
      );
    });
}
for (const operation of ['get', 'template'] as const)
  schemas
    .command(operation)
    .argument('<ref>')
    .description(
      operation === 'template'
        ? 'Illustrative experiment and observation placeholders; replace, never record as measured values'
        : 'Published schema definition',
    )
    .action(async (ref: string) =>
      send(
        `/schemas/${encodeURIComponent(await resolveSchema(ref))}${operation === 'template' ? '/template' : ''}`,
      ),
    );
schemas
  .command('extend')
  .argument('<ref>')
  .requiredOption(
    '--json <json|->',
    'Complete replacement definition: {definition:{parameters,observations,comparisonContext}}; optional backfill:{field:{RUN_ID:value}} for fields a run predates',
  )
  .option('--dry-run', 'Validate and preview affected records without saving')
  .description(
    'Publish a compatible successor and atomically re-pin matching experiments, runs, defaults and charts; old versions and snapshots remain intact',
  )
  .addHelpText(
    'after',
    '\nbackfill fills in parameter or context fields runs left empty -- added by this extension,\nor there all along and forgotten -- on runs this extension re-pins, finished runs included, e.g.\n  {"definition":{...},"backfill":{"packager":{"RUN_ID":"unsloth"}}}\nName a field parameters.<field> or comparisonContext.<field> if the bare name is\nambiguous. Never over a recorded value; values are validated with the extension. Runs note\nthem in research.backfilled with when and by whom, and a backfilled value stays correctable\nwith runs update. For a field the schema already has, runs backfill needs no extension.\nAdding enum values is an ordinary extension.',
  )
  .action(async (ref: string, options: { json: string; dryRun?: boolean }) => {
    const data = input(options.json);
    if (options.dryRun) data.dryRun = true;
    return send(`/schemas/${encodeURIComponent(await resolveSchema(ref))}/extend`, 'POST', data);
  });
schemas
  .command('validate')
  .argument('<ref>')
  .requiredOption('--json <json|->', 'Payload with parameters/observations/comparisonContext')
  .option('--ready', 'Treat required parameters as blocking rather than advisory')
  .description(
    'Check values without saving; exit code 1 with VALIDATION_FAILED when the payload does not satisfy the schema',
  )
  .action(async (ref: string, options: { json: string; ready?: boolean }) => {
    const data = input(options.json) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      fail('Validation input must be a JSON object');
    if (options.ready) data.ready = true;
    const result = (await request(
      url(),
      `/schemas/${encodeURIComponent(await resolveSchema(ref))}/validate`,
      'POST',
      data,
      credentials(),
    )) as { valid?: boolean; warnings?: unknown[] };
    output(result);
    if (result.valid === false) {
      console.error(
        JSON.stringify({
          code: 'VALIDATION_FAILED',
          message: 'Payload does not satisfy the schema; see stdout for the full report',
          hint: 'Repair stdout issues using their paths, expected values and hints, then rerun validation before writing.',
        }),
      );
      process.exitCode = 1;
    }
  });
const charts = program
  .command('charts')
  .description('Create saved typed bar, line and scatter charts for campaigns or experiments');
for (const operation of ['list', 'fields', 'create'] as const) {
  const command = charts
    .command(operation)
    .option('--campaign <ref>', 'Campaign stub or ID; defaults to workspace')
    .option('--experiment <ref>', 'Experiment stub or ID within campaign');
  if (operation === 'create')
    command.requiredOption(
      '--json <json|->',
      'Object with title, type (bar/line/scatter), schemaVersionId, x and y: {section,field,label?}; - reads stdin',
    );
  if (operation === 'create')
    command.addHelpText(
      'after',
      '\nOptional aggregation: {groupBy:[{section,field}],metric:"mean"|"stdev",spread:"none"|"whiskers"|"band"}. Groups retain X and context boundaries; sample SD uses n-1 (unavailable for n<2). Spread requires mean; bands require line. No arbitrary expressions.',
    );
  command
    .description(
      operation === 'fields'
        ? 'Discover scoped schema versions, typed fields and supported chart types'
        : operation === 'list'
          ? 'List saved chart definitions'
          : 'Save an immutable chart definition; live successful runs, optionally grouped with mean or sample stdev',
    )
    .action(async (options: { campaign?: string; experiment?: string; json?: string }) => {
      const scope = apiScope();
      const campaign = await scope.campaign(options.campaign);
      const target = options.experiment
        ? `/experiments/${encodeURIComponent(await scope.work('experiments', options.experiment, campaign.id))}`
        : path(campaign.id);
      return send(
        `${target}/charts${operation === 'fields' ? '/fields' : ''}`,
        operation === 'create' ? 'POST' : 'GET',
        operation === 'create' ? input(options.json!) : undefined,
      );
    });
}
for (const operation of ['get', 'data', 'delete'] as const)
  charts
    .command(operation)
    .argument('<id>', 'Chart ID returned by create/list')
    .description(
      operation === 'data'
        ? 'Live points with source run IDs/revisions, context series, exclusions and timestamp'
        : operation === 'delete'
          ? 'Delete a saved chart definition, never its source runs'
          : 'Get a saved chart definition',
    )
    .action((id: string) =>
      send(
        `/charts/${encodeURIComponent(id)}${operation === 'data' ? '/data' : ''}`,
        operation === 'delete' ? 'DELETE' : 'GET',
      ),
    );
charts
  .command('series')
  .argument('<id>', 'Chart ID returned by create/list')
  .requiredOption(
    '--json <json|->',
    'Object with series: {by:"field",section,field}, {by:"groups",groups:[{label,runIds}],otherLabel?}, or null',
  )
  .description(
    "Choose what a raw chart's colours mean: a typed field, groups of runs you define, or null for comparison context",
  )
  .addHelpText(
    'after',
    '\nBy field colours each point by a parameter or comparison-context value, e.g.\n  {"series":{"by":"field","section":"parameters","field":"recipe_family"}}\nBy groups names the split no single field records, e.g. ours against as shipped:\n  {"series":{"by":"groups","groups":[{"label":"Ours","runIds":["RUN_ID"]}],"otherLabel":"Shipped"}}\nOnly runs the chart plots, each in one group; the rest join otherLabel. Each point\nstill reports its comparison context. Not for aggregated charts. Also accepted by create.',
  )
  .action((id: string, options: { json: string }) =>
    send(`/charts/${encodeURIComponent(id)}/series`, 'PUT', input(options.json)),
  );
charts
  .command('frontier')
  .argument('<id>', 'Chart ID returned by create/list')
  .requiredOption(
    '--json <json|->',
    'Object with runIds: the run IDs to join, replacing any earlier choice; [] clears it',
  )
  .description(
    'Choose the runs a scatter chart joins as its frontier; only runs it plots, never computed',
  )
  .addHelpText(
    'after',
    '\nA frontier is a judgement, not a calculation: pick the runs that are comparable and\nrepresent the trade-off. Scatter charts without aggregation only. The line is drawn\nthrough the chosen runs in X order.',
  )
  .action((id: string, options: { json: string }) =>
    send(`/charts/${encodeURIComponent(id)}/frontier`, 'PUT', input(options.json)),
  );
program
  .command('whoami')
  .description(
    'Who this credential is, the organization it acts in, and the permissions it currently holds',
  )
  .addHelpText(
    'after',
    '\nPermissions are derived per request, so this is what a write would actually be allowed\nto do -- not a profile name or a role. An agent credential also reports itself, since\nnothing else tells it which agent it is or whose work it will be attributed to.',
  )
  .action(() => send('/me'));
const products = program.command('products').description('Manage products');
products.command('list').action(() => send('/products'));
products
  .command('get')
  .argument('<ref>')
  .description('Get a product by stub or ID')
  .action(async (reference: string) =>
    send(`/products/${encodeURIComponent((await apiScope().product(reference)).id)}`),
  );
products
  .command('create')
  .requiredOption('--json <json|->', 'JSON with name; - reads stdin')
  .action((options: { json: string }) => send('/products', 'POST', input(options.json)));
products
  .command('update')
  .argument('<ref>')
  .requiredOption('--json <json|->', 'Patch with expected revision')
  .action(async (reference: string, options: { json: string }) =>
    send(
      `/products/${encodeURIComponent((await apiScope().product(reference)).id)}`,
      'PATCH',
      input(options.json),
    ),
  );
products
  .command('delete')
  .argument('<ref>')
  .option(
    '--confirm <name>',
    'The product name, required when it holds work: its campaigns and everything in them go too',
  )
  .description(
    'Delete a product and everything in it, for good. To keep the work out of the way instead, use archive',
  )
  .action(async (reference: string, options: { confirm?: string }) =>
    send(
      `/products/${encodeURIComponent((await apiScope().product(reference)).id)}`,
      'DELETE',
      options.confirm ? { confirm: options.confirm } : undefined,
    ),
  );
for (const kind of ['experiments', 'runs'] as const) {
  const group = program
    .command(kind)
    .description(`Manage ${kind}; status updates record state, never launch or stop jobs`);
  const resolveRef = (reference: string, campaignRef?: string) =>
    apiScope().work(kind, reference, campaignRef);
  const list = group
    .command('list')
    .option('--campaign <ref>', 'Defaults to the local workspace campaign')
    .option(
      '--where <expression>',
      'Keep records matching FIELD=VALUE, or != >= <= > <; repeatable and combined with AND',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--fields <paths>',
      'Comma-separated paths to print instead of whole records, such as parameters.n,observations.accuracy',
    )
    .option('--format <format>', 'json (default) or tsv', 'json')
    .option(
      '--include-superseded',
      'Include records whose extras.superseded_by names a replacement',
    )
    .option(
      '--include-abandoned',
      kind === 'runs' ? 'Include runs of abandoned experiments' : 'Include abandoned experiments',
    );
  if (kind === 'runs')
    list.option('--experiment <ref>', 'Only runs of this experiment, by stub or ID');
  else list.option('--include-archived', 'Include archived experiments');
  list
    .description(
      `List ${kind}; superseded records, abandoned and archived work are excluded unless asked for`,
    )
    .action(
      async (options: {
        campaign?: string;
        experiment?: string;
        where: string[];
        fields?: string;
        format: string;
        includeSuperseded?: boolean;
        includeAbandoned?: boolean;
        includeArchived?: boolean;
      }) => {
        if (!['json', 'tsv'].includes(options.format)) fail('--format must be json or tsv');
        const scope = apiScope();
        const campaign = await scope.campaign(options.campaign);
        let rows = await requestAll<Row>(
          url(),
          `${path(campaign.id)}/${kind}${options.includeArchived ? '?archived=include' : ''}`,
          credentials(),
        );
        if (options.experiment) {
          const experimentId = await scope.work('experiments', options.experiment, campaign.id);
          rows = rows.filter((row) => row['experimentId'] === experimentId);
        }
        if (!options.includeSuperseded)
          rows = rows.filter((row) => resolve(kind, row, 'extras.superseded_by') == null);
        if (!options.includeAbandoned) {
          if (kind === 'experiments') rows = rows.filter((row) => row['status'] !== 'abandoned');
          else {
            const abandoned = new Set(
              (await requestAll<Row>(url(), `${path(campaign.id)}/experiments`, credentials()))
                .filter((e) => e['status'] === 'abandoned')
                .map((e) => e['id']),
            );
            rows = rows.filter((row) => !abandoned.has(row['experimentId']));
          }
        }
        rows = filterRows(kind, rows, options.where.map(parseCondition));
        const fields = options.fields
          ? options.fields
              .split(',')
              .map((field) => field.trim())
              .filter(Boolean)
          : [];
        if (fields.length) rows = projectRows(kind, rows, fields);
        return options.format === 'tsv' ? console.log(toTsv(rows, fields)) : output(rows);
      },
    );
  if (kind === 'runs')
    group
      .command('record')
      .argument('<ref>')
      .option('--campaign <ref>', 'Defaults to the local workspace campaign')
      .requiredOption(
        '--json <json|->',
        'Object with observations and/or a status; optional errorSummary, extras, extrasMode (replace|merge), comparisonContext, allowIncompleteComparisonContext, artifacts, startedAt, finishedAt, revision',
      )
      .description(
        'Record an outcome in one call: the server reads the current revision, and a result may be recorded directly from planned. Summary observations, not logs: link those with logsUri',
      )
      .action(async (reference: string, options: { campaign?: string; json: string }) =>
        send(
          `/runs/${encodeURIComponent(await resolveRef(reference, options.campaign))}/record`,
          'POST',
          input(options.json),
        ),
      );
  if (kind === 'runs')
    group
      .command('backfill')
      .argument('<ref>')
      .option('--campaign <ref>', 'Defaults to the local workspace campaign')
      .requiredOption(
        '--json <json|->',
        'Object with parameters and/or comparisonContext: the fields to fill in, e.g. {"comparisonContext":{"git_commit":"a1b2c3d"}}',
      )
      .description(
        'Fill in a parameter or comparison-context field a run left empty, finished runs included. Never over a recorded value; noted as added later, with when and by whom. A field the schema lacks is added with schemas extend.',
      )
      .action(async (reference: string, options: { campaign?: string; json: string }) =>
        send(
          `/runs/${encodeURIComponent(await resolveRef(reference, options.campaign))}/backfill`,
          'POST',
          input(options.json),
        ),
      );
  for (const operation of ['get', 'context'] as const)
    group
      .command(operation)
      .argument('<ref>')
      .option('--campaign <ref>', 'Defaults to the local workspace campaign')
      .description(
        'Record by stub or ID with live parent context' +
          (kind === 'runs' ? ' and creation-time snapshot' : ' and child runs'),
      )
      .action(async (reference: string, options: { campaign?: string }) =>
        send(`/${kind}/${encodeURIComponent(await resolveRef(reference, options.campaign))}`),
      );
  const create = group
    .command('create')
    .option('--campaign <ref>', 'Campaign stub or ID; defaults to the local workspace campaign');
  if (kind === 'runs')
    create.option(
      '--experiment <ref>',
      'Experiment stub or ID in campaign scope; cannot combine with JSON experimentId',
    );
  create
    .description(
      kind === 'runs'
        ? 'Create a run record, optionally already terminal with its results; this does not execute a job. Record parameters, comparison context and summary numbers; link logs and raw outputs with logsUri or artifacts (run data is limited by plan: 64 KB on Free)'
        : 'Create an experiment with a hypothesis and optional schema version',
    )
    .requiredOption(
      '--json <json|->',
      kind === 'runs'
        ? 'Object requiring title; optional stub, status, config, observations, comparisonContext, extras, startedAt, finishedAt, errorSummary; - reads stdin'
        : 'Object requiring name and hypothesis; optional parameters, schemaVersionId, varying, comparisonContext, extras; - reads stdin',
    )
    .action(async (options: { campaign?: string; experiment?: string; json: string }) => {
      const payload = input(options.json) as Record<string, unknown>;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        fail('JSON input must be an object');
      const campaign = await apiScope().campaign(options.campaign);
      if (options.experiment) {
        if (kind !== 'runs') fail('--experiment is only supported for runs');
        if ('experimentId' in payload)
          fail('Provide the experiment via --experiment or experimentId, not both');
        payload.experimentId = await apiScope().work(
          'experiments',
          options.experiment,
          campaign.id,
        );
      }
      return send(`${path(campaign.id)}/${kind}`, 'POST', payload);
    });
  group
    .command('update')
    .argument('<ref>')
    .option('--campaign <ref>', 'Defaults to the local workspace campaign')
    .requiredOption('--json <json|->', 'Patch with expected revision')
    .action(async (reference: string, options: { campaign?: string; json: string }) =>
      send(
        `/${kind}/${encodeURIComponent(await resolveRef(reference, options.campaign))}`,
        'PATCH',
        input(options.json),
      ),
    );
  group
    .command('delete')
    .argument('<ref>')
    .option('--campaign <ref>', 'Defaults to the local workspace campaign')
    .requiredOption(
      '--revision <number>',
      kind === 'runs'
        ? 'Expected revision; only a planned run can be deleted, a run that started is kept'
        : 'Expected revision',
    )
    .option(
      '--confirm <name>',
      kind === 'experiments'
        ? 'The experiment name, required when it holds runs: they are deleted too'
        : 'Not used for runs',
    )
    .action(
      async (
        reference: string,
        options: { campaign: string; revision: string; confirm?: string },
      ) => {
        const revision = Number(options.revision);
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw new Error('Revision must be a positive integer');
        return send(
          `/${kind}/${encodeURIComponent(await resolveRef(reference, options.campaign))}`,
          'DELETE',
          {
            revision,
            ...(options.confirm && kind === 'experiments' ? { confirm: options.confirm } : {}),
          },
        );
      },
    );
  if (kind === 'experiments')
    for (const action of ['archive', 'restore'] as const)
      group
        .command(action)
        .argument('<ref>')
        .option('--campaign <ref>', 'Defaults to the local workspace campaign')
        .description(
          action === 'archive'
            ? 'File an experiment away: out of lists and closed to new runs; nothing is lost'
            : 'Bring an archived experiment back',
        )
        .action(async (reference: string, options: { campaign?: string }) =>
          send(
            `/experiments/${encodeURIComponent(await resolveRef(reference, options.campaign))}/${action}`,
            'POST',
          ),
        );
}
for (const action of ['archive', 'restore'] as const) {
  campaigns
    .command(action)
    .argument('<ref>')
    .description(
      action === 'archive'
        ? 'File a campaign away: out of lists and closed to new work; nothing is lost'
        : 'Bring an archived campaign back',
    )
    .action(async (reference: string) =>
      send(`${path((await apiScope().campaign(reference)).id)}/${action}`, 'POST'),
    );
  products
    .command(action)
    .argument('<ref>')
    .description(
      action === 'archive'
        ? 'File a product away: out of lists and closed to new campaigns; nothing is lost'
        : 'Bring an archived product back',
    )
    .action(async (reference: string) =>
      send(
        `/products/${encodeURIComponent((await apiScope().product(reference)).id)}/${action}`,
        'POST',
      ),
    );
}
program.addHelpText(
  'after',
  '\nExamples:\n  fieldwork setup campaign --product model-a --campaign memory-study\n  fieldwork runs create --experiment awq --json \'{"title":"Attempt 1"}\'\n  fieldwork schemas validate VERSION_ID --ready --json -\n\nData commands output JSON. Validation reports go to stdout; invalid reports exit 1.\nUse fieldwork <group> <command> --help for payload and scope guidance.\n\nFieldwork is a ledger of experiments, not a log store: record parameters, comparison\ncontext and summary numbers, and link logs and raw outputs with logsUri or artifacts.\nA refusal over a limit carries a hint saying what to record instead.',
);
for (const group of program.commands) {
  for (const command of group.commands) {
    if (!command.description()) command.description(`${command.name()} ${group.name()} records`);
    command.addHelpText(
      'after',
      `\nServer: --url overrides FIELDWORK_URL, LAB_URL, workspace config, then ${DEFAULT_SERVER}.\nA local server needs --url http://127.0.0.1:4310 or FIELDWORK_URL.\nUse --json - for stdin where supported. IDs and stubs are accepted for records;\nschemas require immutable version IDs. Commands never launch or stop jobs.`,
    );
    if (
      ['experiments', 'runs'].includes(group.name()) &&
      ['create', 'update'].includes(command.name())
    )
      command.addHelpText(
        'after',
        '\ncomparisonContext, extras, and ' +
          (group.name() === 'runs' ? 'config and observations' : 'parameters') +
          ' must be JSON objects, not strings.',
      );
    if (group.name() === 'experiments' && ['create', 'update'].includes(command.name()))
      command.addHelpText(
        'after',
        '\nExperiment text limits: name 120 characters; hypothesis, objective, method,\nand conclusion (update only) 4000 characters each. Keep longer procedures\nin a referenced source file; include the exact extraction command in method.',
      );
    if (command.name() === 'update')
      command.addHelpText(
        'after',
        '\nUpdates require the current revision in JSON. Re-read on a conflict; do not\nblindly increment it. Config/parameter/observation objects replace the whole field.',
      );
  }
}
campaigns.commands
  .find((c) => c.name() === 'create')!
  .addHelpText(
    'after',
    '\nExample: fieldwork campaigns create --product model-a --json \'{"name":"Memory study","goal":"Fit in 24 GiB"}\'\nOmit --product and JSON productId for an independent campaign.',
  );
schemas.commands
  .find((c) => c.name() === 'publish')!
  .addHelpText(
    'after',
    '\nExample definition:\n  {"stub":"study","version":1,"definition":{"parameters":{"bits":{"type":"integer","values":[4,8],"required":true}}}}\nField names use snake_case. Sections: parameters, observations, comparisonContext.\nTypes: number, integer, string, boolean, enum. Published versions cannot be changed.',
  );
schemas.commands
  .find((c) => c.name() === 'validate')!
  .addHelpText(
    'after',
    '\nReads parameters (not run config), observations and comparisonContext.\nNo records are saved. Invalid reports: stdout JSON + stderr VALIDATION_FAILED, exit 1.\nValid reports, including missing-observation warnings: exit 0. --ready checks\nrequired execution fields, but does not start a run or check experiment varying fields.',
  );
try {
  await program.parseAsync();
} catch (error) {
  const failure = error as {
    code?: string;
    message?: string;
    exitCode?: number;
    status?: number;
    details?: unknown;
    hint?: string;
    requestId?: string;
    update?: unknown;
  };
  if (failure.exitCode !== 0) {
    console.error(
      JSON.stringify({
        code: failure.code ?? 'CLIENT_ERROR',
        message: failure.message ?? 'Request failed',
        hint:
          failure.hint ??
          (failure.code?.startsWith('commander.')
            ? 'Run fieldwork --help or fieldwork <group> <command> --help for supported commands, arguments and required options.'
            : failure.code === 'REVISION_CONFLICT'
              ? 'Get the latest record and reconcile your patch using its current revision; do not blindly retry.'
              : failure.message === 'fetch failed'
                ? 'Check the server is running and verify --url, FIELDWORK_URL and workspace configuration; inspect state before retrying a write.'
                : 'Inspect any details.issues for field paths and fixes; use the command’s --help and fieldwork context to verify input and scope.'),
        ...(failure.status ? { status: failure.status } : {}),
        ...(failure.requestId ? { requestId: failure.requestId } : {}),
        ...(failure.details !== undefined ? { details: failure.details } : {}),
        ...(failure.update !== undefined ? { update: failure.update } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
