import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { request, requestAll, type Credentials } from './client.js';

type Ref = { id: string; stub: string };
export type RecordRef = Ref & { productId?: string; campaignId?: string };
export interface Workspace {
  version: 1;
  serverUrl: string;
  product: Ref | null;
  campaign: Ref;
}
export function fail(message: string): never {
  throw new Error(message);
}
export function origin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    fail('Server URL must be an HTTP(S) origin without credentials or a resource path');
  return url.origin;
}
function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function ref(value: unknown): value is Ref {
  if (!value || typeof value !== 'object') return false;
  const r = value as Ref;
  return (
    typeof r.id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(r.id) &&
    typeof r.stub === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.stub)
  );
}
function configDirectory(root: string): string {
  if (stat(join(root, '.fieldwork'))) return '.fieldwork';
  return stat(join(root, '.lab')) ? '.lab' : '.fieldwork';
}
export function readWorkspace(root: string): Workspace | undefined {
  const directory = configDirectory(root);
  const dir = stat(join(root, directory));
  if (dir && (!dir.isDirectory() || dir.isSymbolicLink()))
    fail('Workspace .fieldwork must be a real directory');
  const path = join(root, directory, 'workspace.json');
  const info = stat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) fail('Workspace config must be a regular file');
  const data = JSON.parse(readFileSync(path, 'utf8')) as Workspace;
  if (
    !data ||
    data.version !== 1 ||
    !ref(data.campaign) ||
    !(data.product === null || ref(data.product)) ||
    typeof data.serverUrl !== 'string'
  )
    fail('Invalid workspace config');
  origin(data.serverUrl);
  return data;
}
export function discover(cwd = process.cwd()): { root: string; config: Workspace } | undefined {
  let root = resolve(cwd);
  while (true) {
    const config = readWorkspace(root);
    if (config) return { root, config };
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}
export async function records(
  url: string,
  path: string,
  credentials: Credentials = {},
): Promise<RecordRef[]> {
  // Paged or not: a collection that answers with a page is walked, because resolving a
  // stub against the first fifty rows would fail on the fifty-first record someone made.
  const data = await requestAll<unknown>(url, path, credentials);
  if (!Array.isArray(data) || !data.every(ref))
    fail('Invalid record collection returned by server');
  return data as RecordRef[];
}
export function select(items: RecordRef[], reference: string): RecordRef {
  const matches = items.filter((item) => item.id === reference || item.stub === reference);
  if (matches.length !== 1)
    fail(matches.length ? `Ambiguous reference: ${reference}` : `Record not found: ${reference}`);
  return matches[0]!;
}
export async function setupCampaign(
  url: string,
  options: { product?: string; campaign: string; create?: boolean; goal?: string },
  cwd = process.cwd(),
  credentials: Credentials = {},
) {
  url = origin(url);
  const root = resolve(cwd);
  const directory = configDirectory(root);
  // Validate paths before any server mutation or filesystem writes.
  for (const name of [directory, 'docs', 'assets', 'logs', 'results']) {
    const info = stat(join(root, name));
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      fail(`${name} must be a real directory`);
  }
  const agentNames = ['AGENTS.md', 'agents.md'].filter((name) => stat(join(root, name)));
  if (!agentNames.length) agentNames.push('AGENTS.md');
  for (const name of ['fieldwork-skill.md', ...agentNames]) {
    const info = stat(join(root, name));
    if (info && (!info.isFile() || info.isSymbolicLink())) fail(`${name} must be a regular file`);
  }
  // The built CLI ships the same skill as the Docs page; development reads its source.
  let skill: string;
  try {
    skill = readFileSync(new URL('./fieldwork-skill.md', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    skill = readFileSync(
      new URL('../../web/public/skills/fieldwork/SKILL.md', import.meta.url),
      'utf8',
    );
  }
  const existing = readWorkspace(root);
  const ancestor = discover(dirname(root));
  if (!existing && ancestor)
    fail('Already inside a campaign workspace; setup must run at its root');
  if (existing && existing.serverUrl !== url)
    fail('Workspace is bound to another server; refusing to rebind');
  const products = await records(url, '/products', credentials);
  const product = options.product ? select(products, options.product) : undefined;
  const campaigns = await records(url, '/campaigns', credentials);
  let campaign: RecordRef;
  if (existing && [existing.campaign.id, existing.campaign.stub].includes(options.campaign)) {
    campaign = select(campaigns, existing.campaign.id);
  } else {
    const matches = campaigns.filter(
      (item) => item.id === options.campaign || item.stub === options.campaign,
    );
    if (!matches.length && options.create) {
      if (existing) fail('Workspace is already bound; refusing to create another campaign');
      if (!options.goal?.trim()) fail('--create requires --goal');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.campaign))
        fail('A new campaign requires a valid stub');
      campaign = (await request(
        url,
        '/campaigns',
        'POST',
        {
          name: options.campaign,
          stub: options.campaign,
          goal: options.goal,
          ...(product ? { productId: product.id } : {}),
        },
        credentials,
      )) as RecordRef;
      if (!ref(campaign)) fail('Invalid campaign returned by server');
    } else campaign = select(campaigns, options.campaign);
  }
  if (product && campaign.productId !== product.id)
    fail('Campaign does not belong to the selected product');
  const parent = campaign.productId ? select(products, campaign.productId) : null;
  const config: Workspace = {
    version: 1,
    serverUrl: url,
    product: parent ? { id: parent.id, stub: parent.stub } : null,
    campaign: { id: campaign.id, stub: campaign.stub },
  };
  if (
    existing &&
    (existing.campaign.id !== campaign.id || existing.product?.id !== config.product?.id)
  )
    fail('Workspace is already bound; refusing to rebind');
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const changedFiles = new Map<string, string>();
  try {
    for (const name of [directory, 'docs', 'assets', 'logs', 'results']) {
      const path = join(root, name);
      if (!stat(path)) {
        mkdirSync(path);
        createdDirs.push(path);
      }
    }
    const readme = join(root, 'README.md');
    if (!stat(readme)) {
      writeFileSync(
        readme,
        `# Fieldwork campaign workspace\n\nRun \`fieldwork context\` to inspect live intent and scope.\n\n- docs/: plans and notes\n- assets/: supporting files\n- logs/: execution logs and diagnostics\n- results/: metrics and outputs\n\nFiles are not automatically uploaded; Fieldwork does not execute jobs.\n`,
        { flag: 'wx' },
      );
      createdFiles.push(readme);
    }
    const skillPath = join(root, 'fieldwork-skill.md');
    if (!stat(skillPath)) {
      writeFileSync(skillPath, skill, { flag: 'wx' });
      createdFiles.push(skillPath);
    }
    for (const name of agentNames) {
      const path = join(root, name);
      const present = stat(path);
      const content = present ? readFileSync(path, 'utf8') : '';
      if (content.includes('fieldwork-skill.md')) continue;
      const reference =
        '\n\n## Fieldwork workspace\n\nRead [fieldwork-skill.md](./fieldwork-skill.md) for CLI usage, inherited campaign context, and how to record experiments and runs. Run `fieldwork context` before changing records. Fieldwork tracks work; it does not execute jobs.\n';
      if (present) {
        changedFiles.set(path, content);
        appendFileSync(path, reference);
      } else {
        writeFileSync(path, '# Agent instructions' + reference, { flag: 'wx' });
        createdFiles.push(path);
      }
    }
    if (!existing) {
      const path = join(root, directory, 'workspace.json');
      writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      createdFiles.push(path);
    }
  } catch (error) {
    for (const [path, content] of changedFiles) writeFileSync(path, content);
    for (const path of createdFiles.reverse()) unlinkSync(path);
    for (const path of createdDirs.reverse()) {
      try {
        rmdirSync(path);
      } catch {
        /* Leave directories containing concurrent user files. */
      }
    }
    throw error;
  }
  return { root, config: existing ?? config, created: !existing };
}

/** Resolving a stub or an id to a record, against one server.
 *
 * Every lookup here sends the caller's credentials. It is the same collection the command
 * itself would read, so omitting them made every ref-taking command -- update, delete,
 * record, get -- fail with 401 against a server that authenticates, while the same
 * credential worked for a plain list.
 */
/** The hosted service. A local server is the exception now, and says so with --url,
 *  FIELDWORK_URL, or the workspace it was set up against. */
export const DEFAULT_SERVER = 'https://app.fieldworkledger.com';
export class Scope {
  readonly workspace;
  readonly url: string;
  readonly credentials: Credentials;
  constructor(url?: string, cwd = process.cwd(), credentials: Credentials = {}) {
    this.credentials = credentials;
    this.workspace = discover(cwd);
    this.url = origin(
      url ??
        process.env['FIELDWORK_URL'] ??
        process.env['LAB_URL'] ??
        this.workspace?.config.serverUrl ??
        DEFAULT_SERVER,
    );
  }
  private local() {
    if (this.workspace && this.url !== this.workspace.config.serverUrl)
      fail('Server differs from workspace; supply explicit scope instead of reusing local IDs');
    return this.workspace?.config;
  }
  // Resolution sees archived records too: restoring one, or reading it, names it by stub.
  async product(reference: string) {
    return select(
      await records(this.url, '/products?archived=include', this.credentials),
      reference,
    );
  }
  async campaign(reference?: string) {
    const target = reference ?? this.local()?.campaign.id;
    if (!target) fail('Supply --campaign or run setup campaign first');
    const campaign = select(
      await records(this.url, '/campaigns?archived=include', this.credentials),
      target,
    );
    if (!reference && campaign.productId !== this.local()?.product?.id)
      fail('Campaign parent changed; inspect workspace binding');
    return campaign;
  }
  async work(kind: 'experiments' | 'runs', reference: string, campaignRef?: string) {
    if (!campaignRef && !this.workspace && /^[0-9a-f-]{36}$/i.test(reference)) return reference;
    const campaign = await this.campaign(campaignRef);
    return select(
      await records(
        this.url,
        `/campaigns/${campaign.id}/${kind}?archived=include`,
        this.credentials,
      ),
      reference,
    ).id;
  }
  async context(reference?: string) {
    const campaign = await this.campaign(reference);
    return {
      root: this.workspace?.root,
      serverUrl: this.url,
      campaign,
      detail: await request(
        this.url,
        `/campaigns/${campaign.id}`,
        'GET',
        undefined,
        this.credentials,
      ),
    };
  }
}
