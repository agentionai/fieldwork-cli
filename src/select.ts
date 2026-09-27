// Row selection and projection for list commands. The CLI chooses and prints recorded values; it never
// computes new ones. Anything derived belongs in a real language reading the JSON.
export type Row = Record<string, unknown>;
export type Kind = 'experiments' | 'runs';
const operators = ['!=', '>=', '<=', '=', '>', '<'] as const;
export type Operator = (typeof operators)[number];
export interface Condition {
  path: string;
  operator: Operator;
  operand: string;
}
const sectionNames = [
  'parameters',
  'observations',
  'comparisonContext',
  'extras',
  'inputRefs',
  'environment',
] as const;
const searched = ['parameters', 'observations', 'comparisonContext', 'extras'] as const;

export function fail(message: string, hint: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_SELECTION', hint });
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
// Schema sections are named the same everywhere; a run stores its parameters under `config`. Servers
// older than the top-level echo only nest the other sections under `research`.
function section(kind: Kind, row: Row, name: string): Record<string, unknown> {
  if (name === 'parameters' && kind === 'runs') return object(row['config']);
  return object(row[name] === undefined ? object(row['research'])[name] : row[name]);
}
function walk(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );
}
export function resolve(kind: Kind, row: Row, path: string): unknown {
  const parts = path.split('.');
  const head = parts[0]!;
  if (parts.length > 1 && (sectionNames as readonly string[]).includes(head))
    return walk(section(kind, row, head), parts.slice(1));
  if (Object.hasOwn(row, head)) return walk(row, parts);
  const research = object(row['research']);
  if (Object.hasOwn(research, head)) return walk(research, parts);
  if (parts.length > 1) return undefined;
  const found = searched.filter((name) => Object.hasOwn(section(kind, row, name), head));
  if (found.length > 1)
    fail(
      `Ambiguous field '${head}': ${found.map((name) => `${name}.${head}`).join(', ')}`,
      'Qualify the field with its section, for example parameters.variant.',
    );
  return found.length ? section(kind, row, found[0]!)[head] : undefined;
}
export function parseCondition(expression: string): Condition {
  for (let index = 0; index < expression.length; index += 1) {
    const operator = operators.find((candidate) => expression.startsWith(candidate, index));
    if (!operator) continue;
    const path = expression.slice(0, index).trim();
    if (!path) break;
    return { path, operator, operand: expression.slice(index + operator.length).trim() };
  }
  return fail(
    `Cannot read --where '${expression}'`,
    "Use FIELD=VALUE, or one of != >= <= > <, for example --where 'parameters.n>=4'.",
  );
}
function equals(value: unknown, operand: string): boolean {
  if (value === undefined) return operand === '';
  if (typeof value === 'number') return Number(operand) === value && operand.trim() !== '';
  if (typeof value === 'boolean') return String(value) === operand;
  if (typeof value === 'string') return value === operand;
  if (value === null) return operand === 'null';
  return JSON.stringify(value) === operand;
}
export function matches(value: unknown, condition: Condition): boolean {
  if (condition.operator === '=') return equals(value, condition.operand);
  if (condition.operator === '!=') return !equals(value, condition.operand);
  if (value === undefined || value === null) return false;
  const numeric =
    typeof value === 'number' &&
    condition.operand.trim() !== '' &&
    Number.isFinite(Number(condition.operand));
  const [left, right] = numeric
    ? [value as number, Number(condition.operand)]
    : [String(value), condition.operand];
  return condition.operator === '>'
    ? left > right
    : condition.operator === '>='
      ? left >= right
      : condition.operator === '<'
        ? left < right
        : left <= right;
}
// A path that resolves nowhere in a nonempty result is a typo, not an empty column: say so instead of
// printing a silent blank that a reader would take for a measured absence.
function requirePresent(kind: Kind, rows: Row[], paths: readonly string[], flag: string) {
  for (const path of paths) {
    if (rows.length && rows.every((row) => resolve(kind, row, path) === undefined))
      fail(
        `No record has ${flag} field '${path}'`,
        'Check the spelling and section, or list one record in full to see the available fields.',
      );
  }
}
export function filterRows(kind: Kind, rows: Row[], conditions: readonly Condition[]): Row[] {
  requirePresent(
    kind,
    rows,
    conditions.map((condition) => condition.path),
    '--where',
  );
  return rows.filter((row) =>
    conditions.every((condition) => matches(resolve(kind, row, condition.path), condition)),
  );
}
export function projectRows(kind: Kind, rows: Row[], fields: readonly string[]): Row[] {
  requirePresent(kind, rows, fields, '--fields');
  return rows.map((row) =>
    Object.fromEntries(fields.map((path) => [path, resolve(kind, row, path)])),
  );
}
function cell(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n');
}
export function toTsv(rows: Row[], fields: readonly string[]): string {
  const columns = fields.length
    ? [...fields]
    : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    columns.join('\t'),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join('\t')),
  ].join('\n');
}
