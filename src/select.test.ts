import { expect, it } from 'vitest';
import {
  filterRows,
  matches,
  parseCondition,
  projectRows,
  resolve,
  toTsv,
  type Row,
} from './select.js';

const run = (title: string, config: Row, observations: Row, extras: Row = {}): Row => ({
  id: title,
  stub: title,
  title,
  status: 'succeeded',
  experimentId: 'sweep',
  config,
  observations,
  comparisonContext: { model: 'qwopus' },
  extras,
  research: {
    schemaVersionId: 'schema',
    observations,
    comparisonContext: { model: 'qwopus' },
    extras,
  },
});
const rows: Row[] = [
  run('a', { n: 4 }, { accuracy: 0.61 }),
  run('b', { n: 8 }, { accuracy: 0.68 }, { superseded_by: 'c' }),
  run('c', { n: 16 }, { accuracy: 0.72, note: 'x\ty' }),
];

it('resolves section paths, bare names and the legacy nesting under research', () => {
  expect(resolve('runs', rows[0]!, 'parameters.n')).toBe(4);
  expect(resolve('runs', rows[0]!, 'n')).toBe(4);
  expect(resolve('runs', rows[0]!, 'observations.accuracy')).toBe(0.61);
  expect(resolve('runs', rows[0]!, 'status')).toBe('succeeded');
  expect(resolve('runs', rows[0]!, 'comparisonContext.model')).toBe('qwopus');
  expect(resolve('runs', rows[1]!, 'extras.superseded_by')).toBe('c');
  expect(resolve('runs', rows[0]!, 'schemaVersionId')).toBe('schema');
  expect(
    resolve('runs', { config: {}, research: { observations: { accuracy: 1 } } }, 'accuracy'),
  ).toBe(1);
  expect(resolve('experiments', { parameters: { n: 2 } }, 'parameters.n')).toBe(2);
  expect(resolve('runs', rows[0]!, 'observations.missing')).toBeUndefined();
  expect(() => resolve('runs', run('d', { shared: 1 }, { shared: 2 }), 'shared')).toThrow(
    /Ambiguous field/,
  );
});

it('parses comparisons and never coerces across types', () => {
  expect(parseCondition('model=qwopus')).toEqual({
    path: 'model',
    operator: '=',
    operand: 'qwopus',
  });
  expect(parseCondition('parameters.n>=4')).toEqual({
    path: 'parameters.n',
    operator: '>=',
    operand: '4',
  });
  expect(parseCondition('note!=a=b')).toEqual({ path: 'note', operator: '!=', operand: 'a=b' });
  expect(() => parseCondition('accuracy')).toThrow(/Cannot read --where/);
  expect(matches(4, parseCondition('n=4'))).toBe(true);
  expect(matches('4', parseCondition('n=4'))).toBe(true);
  expect(matches(4, parseCondition('n=four'))).toBe(false);
  expect(matches(true, parseCondition('thinking=true'))).toBe(true);
  expect(matches(undefined, parseCondition('n>1'))).toBe(false);
  expect(matches(undefined, parseCondition('n!=1'))).toBe(true);
  expect(matches(undefined, parseCondition('n='))).toBe(true);
  expect(matches('', parseCondition('n='))).toBe(true);
  expect(matches(16, parseCondition('n>8'))).toBe(true);
  expect(matches('2026-09-17', parseCondition('day>2026-09-01'))).toBe(true);
});

it('filters and projects without computing new values, and flags paths nothing has', () => {
  expect(
    filterRows('runs', rows, [
      parseCondition('model=qwopus'),
      parseCondition('parameters.n>=8'),
    ]).map((row) => row['title']),
  ).toEqual(['b', 'c']);
  expect(
    filterRows('runs', rows, [parseCondition('extras.superseded_by=')]).map((row) => row['title']),
  ).toEqual(['a', 'c']);
  expect(
    filterRows('runs', rows, [parseCondition('extras.superseded_by!=')]).map((row) => row['title']),
  ).toEqual(['b']);
  expect(() => filterRows('runs', rows, [parseCondition('parameters.nn=4')])).toThrow(
    /No record has --where field/,
  );
  expect(() => projectRows('runs', rows, ['observations.acuracy'])).toThrow(
    /No record has --fields field/,
  );
  expect(filterRows('runs', [], [parseCondition('anything=1')])).toEqual([]);
  expect(projectRows('runs', rows, ['parameters.n', 'observations.accuracy'])).toEqual([
    { 'parameters.n': 4, 'observations.accuracy': 0.61 },
    { 'parameters.n': 8, 'observations.accuracy': 0.68 },
    { 'parameters.n': 16, 'observations.accuracy': 0.72 },
  ]);
});

it('prints a TSV whose cells never break the row or column structure', () => {
  const projected = projectRows('runs', rows, ['title', 'observations.note', 'parameters.n']);
  expect(toTsv(projected, ['title', 'observations.note', 'parameters.n']).split('\n')).toEqual([
    'title\tobservations.note\tparameters.n',
    'a\t\t4',
    'b\t\t8',
    'c\tx\\ty\t16',
  ]);
});
