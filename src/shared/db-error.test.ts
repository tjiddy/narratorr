import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DrizzleQueryError } from 'drizzle-orm';
import { describeDbError } from './db-error.js';
import { getErrorMessage } from './error-message.js';
import {
  LEAK_SUBSTRINGS,
  PASSKEY,
  TORRENT_BASE64,
  expectNoLeak,
  makeLeakyDrizzleError,
} from '../server/__tests__/drizzle-error.fixture.js';

/** The predicate AC3 forbids, kept here as the executable counterfactual for T41. */
const forbiddenPredicate = (error: unknown): boolean => {
  const e = error as { query?: unknown; params?: unknown };
  // Both reads happen up front so the counterfactual sees either accessor, not just the first.
  const query = e.query;
  const params = e.params;
  return typeof query === 'string' && Array.isArray(params);
};

describe('describeDbError — detection (T1)', () => {
  it('summarizes a real drizzle query error', () => {
    const summary = describeDbError(makeLeakyDrizzleError());
    expect(summary).toContain('downloads');
    expect(summary).toContain('insert');
    expect(summary).toContain('FOREIGN KEY constraint failed');
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a bare libsql-shaped cause', Object.assign(new Error('SQLITE_CONSTRAINT: x'), { code: 'SQLITE_CONSTRAINT' })],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('returns null for %s', (_label, value) => {
    expect(describeDbError(value)).toBeNull();
  });

  // Both fields are required, or an unrelated error carrying a `query` field gets mangled.
  it('requires BOTH query and params — neither alone is the signature', () => {
    const queryOnly = Object.assign(new Error('boom'), { query: 'insert into "downloads"' });
    const paramsOnly = Object.assign(new Error('boom'), { params: ['a'] });
    expect(describeDbError(queryOnly)).toBeNull();
    expect(describeDbError(paramsOnly)).toBeNull();
  });
});

describe('describeDbError — own-data-property inspection (T41)', () => {
  it('rejects a prototype-inherited query/params pair', () => {
    const proto = { query: 'insert into "downloads" values (?)', params: ['x'] };
    const inherited = Object.create(proto) as object;

    expect(describeDbError(inherited)).toBeNull();
    // Counterfactual: the forbidden predicate accepts exactly this shape.
    expect(forbiddenPredicate(inherited)).toBe(true);
  });

  it.each(['query', 'params'])('never invokes a throwing %s getter', (key) => {
    const err = new Error('ordinary failure');
    Object.defineProperty(err, key, {
      get() {
        throw new Error('accessor invoked');
      },
      configurable: true,
      enumerable: true,
    });

    expect(describeDbError(err)).toBeNull();
    expect(() => getErrorMessage(err)).not.toThrow();
    expect(getErrorMessage(err)).toBe('ordinary failure');
    // Counterfactual: the forbidden predicate detonates on the same input.
    expect(() => forbiddenPredicate(err)).toThrow('accessor invoked');
  });

  it('rejects an accessor that returns a valid-looking signature', () => {
    const err = new Error('ordinary failure');
    Object.defineProperty(err, 'query', { get: () => 'insert into "downloads" values (?)', configurable: true });
    Object.defineProperty(err, 'params', { get: () => ['x'], configurable: true });

    expect(describeDbError(err)).toBeNull();
    expect(forbiddenPredicate(err)).toBe(true);
  });

  it('survives a Proxy whose getOwnPropertyDescriptor trap throws', () => {
    const hostile = new Proxy(new Error('ordinary failure'), {
      getOwnPropertyDescriptor() {
        throw new Error('trap detonated');
      },
    });

    expect(describeDbError(hostile)).toBeNull();
    expect(() => getErrorMessage(hostile)).not.toThrow();
  });
});

describe('describeDbError — the cause walk terminates (T42)', () => {
  const drizzleWrapping = (cause: Error): Error =>
    new DrizzleQueryError('insert into "downloads" values (?)', ['x'], cause);

  // `occurrences` is what makes the identity set falsifiable: the depth cap alone terminates a
  // cycle, but only the `seen` set stops it re-emitting the same link on every remaining hop.
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it('handles a self-referential cause', () => {
    const self = new Error('link-self');
    (self as Error & { cause?: unknown }).cause = self;

    const summary = describeDbError(drizzleWrapping(self))!;
    expect(occurrences(summary, 'link-self')).toBe(1);
  });

  it('handles a two-node cause cycle', () => {
    const a = new Error('link-a');
    const b = new Error('link-b');
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;

    const summary = describeDbError(drizzleWrapping(a))!;
    expect(occurrences(summary, 'link-a')).toBe(1);
    expect(occurrences(summary, 'link-b')).toBe(1);
  });

  // Liveness guard only — a non-terminating walk hangs the run rather than failing it.
  it('truncates a chain deeper than the cap', { timeout: 5000 }, () => {
    let deepest = new Error('link-8');
    for (let i = 7; i >= 1; i--) {
      deepest = new Error(`link-${i}`, { cause: deepest });
    }

    const summary = describeDbError(drizzleWrapping(deepest));
    expect(summary).toContain('link-1');
    expect(summary).not.toContain('link-8');
  });
});

describe('describeDbError — the params never survive (T2)', () => {
  it('carries none of the bound values', () => {
    const raw = makeLeakyDrizzleError();
    // Stimulus check: the assertion below is only meaningful if the raw message really leaks.
    // The passkey rides the params line base64-encoded, so that is the substring the raw text carries.
    expect(raw.message).toContain(TORRENT_BASE64);
    expect(Buffer.from(TORRENT_BASE64, 'base64').toString()).toContain(PASSKEY);

    expectNoLeak(describeDbError(raw)!);
  });

  it('omits the SQL body, not merely the params', () => {
    const summary = describeDbError(makeLeakyDrizzleError())!;
    expect(summary).not.toContain('values (?');
    expect(summary).not.toContain('public_id');
  });
});

describe('describeDbError — target extraction (T3)', () => {
  const summaryFor = (query: string): string =>
    describeDbError(new DrizzleQueryError(query, ['x'], new Error('boom')))!;

  it.each([
    ['insert into "downloads" ("id") values (?)', 'insert', 'downloads'],
    ['update "books" set "status" = ? where "id" = ?', 'update', 'books'],
    ['delete from "book_events" where "id" = ?', 'delete', 'book_events'],
    ['select "id", "title" from "downloads" where "book_id" = ?', 'select', 'downloads'],
  ])('%s → %s on %s', (query, operation, table) => {
    const summary = summaryFor(query);
    expect(summary).toContain(operation);
    expect(summary).toContain(table);
  });

  it.each([['an empty query', ''], ['unparseable SQL', 'PRAGMA foreign_keys']])(
    'falls back to unknown for %s',
    (_label, query) => {
      const summary = summaryFor(query);
      expect(summary).toContain('unknown');
      expect(summary).toContain('boom');
    },
  );
});

describe('describeDbError — constraint text by class (T4)', () => {
  it.each([
    'FOREIGN KEY constraint failed',
    'UNIQUE constraint failed: downloads.public_id',
    'CHECK constraint failed: ck_companion_ebooks_status_domain',
  ])('%s appears verbatim', (constraintText) => {
    const summary = describeDbError(
      new DrizzleQueryError('insert into "downloads" values (?)', ['x'], new Error(`SQLITE_CONSTRAINT: ${constraintText}`)),
    );
    expect(summary).toContain(constraintText);
  });
});

describe('describeDbError — delimiter discipline (T6)', () => {
  it('a cause carrying the join token cannot forge a chain entry', () => {
    const forged = new Error('CHECK constraint failed: ck_a | FOREIGN KEY constraint failed');
    const summary = describeDbError(
      new DrizzleQueryError('insert into "downloads" values (?)', ['x'], forged),
    )!;

    // Built by the real renderer so the two halves cannot drift: one genuine link, so one token.
    const genuine = describeDbError(
      new DrizzleQueryError('insert into "downloads" values (?)', ['x'], new Error('plain')),
    )!;
    const tokenCount = (text: string) => text.split(' | ').length - 1;

    expect(tokenCount(genuine)).toBe(0);
    expect(tokenCount(summary)).toBe(0);
    expect(summary).toContain('ck_a');
  });
});

describe('db-error.ts has zero imports (T5)', () => {
  it('keeps drizzle-orm out of the client bundle', () => {
    const source = readFileSync(join(import.meta.dirname, 'db-error.ts'), 'utf-8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe('the summary stays toastable', () => {
  it('bounds a pathological cause message', () => {
    const summary = describeDbError(
      new DrizzleQueryError('insert into "downloads" values (?)', ['x'], new Error('x'.repeat(5000))),
    )!;
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(LEAK_SUBSTRINGS.every((needle) => !summary.includes(needle))).toBe(true);
  });
});
