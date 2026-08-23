import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from './index.js';
import { books } from './schema.js';
import { BookService } from '../server/services/book.service.js';
import { generatePublicId } from '../server/utils/public-id.js';

/**
 * #2595 — the SIGSEGV mitigation had to be chosen from a measurement, not from the concurrency model
 * the crash report assumed. This file IS that measurement: it establishes by observation whether two
 * statements can be inside the libsql native binding at the same time, which decides whether a
 * JS-level serialization lane in `src/db/client.ts` could remove any native overlap at all.
 *
 * Measured against the pinned versions below. Every assertion here is written so a driver that made
 * execution genuinely asynchronous REDS it rather than passing quietly — that is the point of pinning
 * a verdict by measurement: it expires loudly. See docs/crash-forensics.md §7.
 */
const MEASURED_AGAINST = '@libsql/client 0.17.4 / libsql 0.5.29 / drizzle-orm 0.45.2';

/**
 * A recursive-CTE row generator is the only workload that reliably occupies the binding for far
 * longer than an event-loop tick without touching the filesystem or the schema, so the occupancy
 * reading is about statement execution rather than I/O.
 */
const WORKLOAD_ROWS = 400_000;

/**
 * The heartbeat verdict is only meaningful if the workload actually outran a tick. Well under the
 * ~100ms the generator costs on a developer machine, well over the sub-millisecond tick floor, so a
 * loaded CI box cannot false-red it and a suddenly-free statement cannot pass it vacuously.
 */
const OCCUPANCY_FLOOR_MS = 25;

function rowGenerator(rows: number, label: string): string {
  return (
    `WITH RECURSIVE gen(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM gen WHERE x < ${rows}) ` +
    `SELECT '${label}' AS label, count(*) AS n, sum(x) AS s FROM gen`
  );
}

/** The minimal surface both the real client and the counterfactual stub satisfy. */
interface Executor {
  execute: (stmt: string) => Promise<unknown>;
}

interface Occupancy<T> {
  value: T;
  durationMs: number;
  ticksDuring: number;
  /** Ticks an idle window of the same length produced — the calibration that makes `0` mean something. */
  ticksIdle: number;
}

/**
 * Runs `fn` with a self-rearming `setImmediate` loop live and counts the ticks it managed during the
 * call, then repeats the measurement over an idle window of the same length. A synchronous native
 * call cannot yield, so it reads zero; the idle figure proves the loop was running and would have
 * ticked thousands of times had the call yielded.
 */
async function measureOccupancy<T>(fn: () => Promise<T>): Promise<Occupancy<T>> {
  const run = async <R>(body: () => Promise<R>) => {
    let ticks = 0;
    let running = true;
    const beat = () => {
      if (!running) return;
      ticks++;
      setImmediate(beat);
    };
    setImmediate(beat);
    // Let the loop reach steady state before the window opens.
    await new Promise((resolve) => setImmediate(resolve));
    const before = ticks;
    const startedAt = performance.now();
    const value = await body();
    const durationMs = performance.now() - startedAt;
    running = false;
    return { value, durationMs, ticksDuring: ticks - before };
  };

  const measured = await run(fn);
  const idle = await run(() => new Promise((resolve) => setTimeout(resolve, Math.round(measured.durationMs))));

  return { value: measured.value, durationMs: measured.durationMs, ticksDuring: measured.ticksDuring, ticksIdle: idle.ticksDuring };
}

interface SpanEvent {
  label: string;
  phase: 'enter' | 'exit';
  at: number;
}

interface SpanTrace {
  events: SpanEvent[];
  restore: () => void;
}

/**
 * Records enter/exit SYNCHRONOUSLY around the call without awaiting it. An await-based wrapper marks
 * every async facade as overlapping and would make the reading vacuous; this one measures how much of
 * the statement happened inside the caller's own synchronous frame, which is exactly the question.
 *
 * Instance assignment, so a transaction handle is instrumented without prototype surgery — the same
 * observation point `src/server/__tests__/statement-spy.ts` uses, because drizzle dispatches
 * in-transaction queries through `tx.execute` and never `client.execute`.
 */
function traceSyncSpans(target: Executor): SpanTrace {
  const original = target.execute.bind(target);
  const events: SpanEvent[] = [];

  target.execute = ((stmt: string) => {
    const label = /'([A-Z])' AS label/.exec(typeof stmt === 'string' ? stmt : String((stmt as { sql?: string })?.sql ?? ''))?.[1] ?? '?';
    events.push({ label, phase: 'enter', at: performance.now() });
    const pending = original(stmt);
    events.push({ label, phase: 'exit', at: performance.now() });
    return pending;
  }) as Executor['execute'];

  return { events, restore: () => { target.execute = original; } };
}

const order = (events: SpanEvent[]) => events.map((event) => `${event.phase}${event.label}`);

function spanOf(events: SpanEvent[], label: string): number {
  const enter = events.find((event) => event.label === label && event.phase === 'enter')!;
  const exit = events.find((event) => event.label === label && event.phase === 'exit')!;
  return exit.at - enter.at;
}

describe(`libsql statement execution model (measured against ${MEASURED_AGAINST})`, () => {
  let dir: string;
  let dbFile: string;
  let db: Db;
  let client: Executor & { transaction: () => Promise<Executor & { rollback: () => Promise<void> }> };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'stmt-model-'));
    dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    client = db.$client as unknown as typeof client;
  });

  afterAll(() => {
    // libSQL may retain the directory handle on Windows.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  });

  describe('A1 — event-loop occupancy', () => {
    it('does not let the event loop tick once while a statement is inside the binding', async () => {
      const measured = await measureOccupancy(() => client.execute(rowGenerator(WORKLOAD_ROWS, 'A')));

      // Guards the reading against a workload that finished inside one tick: without this the zero
      // below would be true of any trivially fast statement and would prove nothing.
      expect(measured.durationMs).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      // The same window, idle: the loop was live and free to tick throughout.
      expect(measured.ticksIdle).toBeGreaterThan(1_000);

      expect(measured.ticksDuring).toBe(0);
    });

    it('reads a zero-row table without a zero-duration baseline in the timing math', async () => {
      // Fresh migrated DB boundary: the probe query answers empty, and the occupancy reading still
      // comes from the sized generator rather than from dividing by an empty statement's duration.
      expect(await db.select().from(books)).toEqual([]);

      const measured = await measureOccupancy(() => client.execute("SELECT 'Z' AS label, id FROM books"));

      expect(measured.durationMs).toBeGreaterThan(0);
      expect(measured.ticksDuring).toBe(0);
    });
  });

  describe('A1 — two concurrent statements cost the sum, never the max', () => {
    it('takes approximately the sum of the two individual durations', async () => {
      const first = await measureOccupancy(() => client.execute(rowGenerator(WORKLOAD_ROWS, 'A')));
      const second = await measureOccupancy(() => client.execute(rowGenerator(WORKLOAD_ROWS, 'B')));

      const startedAt = performance.now();
      await Promise.all([
        client.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
        client.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
      ]);
      const together = performance.now() - startedAt;

      const sum = first.durationMs + second.durationMs;
      const max = Math.max(first.durationMs, second.durationMs);

      // Tolerance band rather than equality: the two statements are scheduled, not instrumented.
      expect(together).toBeGreaterThan(sum * 0.85);
      // The discriminating half — anything with real native overlap lands at or below max().
      expect(together).toBeGreaterThan(max * 1.6);
    });
  });

  describe('A1/A2 — the synchronous span covers the whole statement', () => {
    it('never enters a second statement on the connection before the first has exited', async () => {
      const trace = traceSyncSpans(client);
      try {
        await Promise.all([
          client.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
          client.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
        ]);
      } finally {
        trace.restore();
      }

      expect(order(trace.events)).toEqual(['enterA', 'exitA', 'enterB', 'exitB']);
      // The whole statement happened inside the caller's synchronous frame — an async driver would
      // return a pending promise here and leave a span of roughly nothing.
      expect(spanOf(trace.events, 'A')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      expect(spanOf(trace.events, 'B')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
    });

    it('shows the same signature on a tx handle, which is where drizzle sends in-transaction queries', async () => {
      const tx = await client.transaction();
      const trace = traceSyncSpans(tx);
      let measured: Occupancy<unknown>;
      try {
        measured = await measureOccupancy(() =>
          Promise.all([
            tx.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
            tx.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
          ]),
        );
      } finally {
        trace.restore();
        await tx.rollback();
      }

      expect(order(trace.events)).toEqual(['enterA', 'exitA', 'enterB', 'exitB']);
      expect(spanOf(trace.events, 'A')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      expect(measured.ticksDuring).toBe(0);
      expect(measured.ticksIdle).toBeGreaterThan(1_000);
    });
  });

  describe('A3 — counterfactual: the probe can detect overlap', () => {
    /**
     * Everything above asserts an absence. Absence assertions are worthless unless the observation
     * point can produce the presence, so the same two probes run against a client whose `execute`
     * genuinely awaits — the shape a future async driver would have — and both must flip.
     */
    const asyncStub = (): Executor => ({
      execute: async (stmt: string) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { rows: [{ label: /'([A-Z])' AS label/.exec(stmt)?.[1] ?? '?' }] };
      },
    });

    it('reports loop ticks and a near-zero synchronous span for a genuinely asynchronous execute', async () => {
      const stub = asyncStub();

      const measured = await measureOccupancy(() => stub.execute(rowGenerator(WORKLOAD_ROWS, 'A')));
      expect(measured.durationMs).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      // The assertion the real client passes — `ticksDuring === 0` — is false here, so it is load-bearing.
      expect(measured.ticksDuring).toBeGreaterThan(1_000);

      const trace = traceSyncSpans(stub);
      await Promise.all([
        stub.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
        stub.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
      ]);
      trace.restore();

      // The span assertion the real client passes is false here too: nothing ran in the sync frame.
      expect(spanOf(trace.events, 'A')).toBeLessThan(OCCUPANCY_FLOOR_MS);
      expect(spanOf(trace.events, 'B')).toBeLessThan(OCCUPANCY_FLOOR_MS);
    });

    it('reports max(), not sum(), for two concurrent asynchronous statements', async () => {
      const stub = asyncStub();

      const startedAt = performance.now();
      await Promise.all([stub.execute(rowGenerator(1, 'A')), stub.execute(rowGenerator(1, 'B'))]);
      const together = performance.now() - startedAt;

      // Two 60ms awaits overlapping land near 60ms, not 120ms — the sum assertion above would red.
      expect(together).toBeLessThan(110);
    });
  });
});

/** Peak statements the JS layer had outstanding at once, and how many were ever inside the binding together. */
interface WaveMeasurement {
  totalStatements: number;
  clientStatements: number;
  transactionStatements: number;
  transactionsOpened: number;
  peakPromisesInFlight: number;
  peakNativeOverlap: number;
  wallTimeMs: number;
}

/**
 * Counts both quantities at once so the difference between them is visible in one reading:
 * `peakPromisesInFlight` is what a JS-level concurrency audit sees, `peakNativeOverlap` is how many
 * statements were ever simultaneously inside the binding. Patches `client.transaction` as well as
 * `client.execute` — a client-only spy counts in-transaction statements zero times and would make
 * the peak figure vacuous.
 */
function measureWave(db: Db) {
  type Handle = Executor & { transaction: (...args: never[]) => Promise<Executor> };
  const client = db.$client as unknown as Handle;
  const originalExecute = client.execute.bind(client);
  const originalTransaction = client.transaction.bind(client);

  const captured: { scope: string }[] = [];
  const transactions: string[] = [];
  let promisesInFlight = 0;
  let nativeOverlap = 0;
  let peakPromisesInFlight = 0;
  let peakNativeOverlap = 0;

  function instrument(target: Executor, scope: string): void {
    const inner = target.execute.bind(target);
    target.execute = ((stmt: string) => {
      captured.push({ scope });
      promisesInFlight++;
      nativeOverlap++;
      peakPromisesInFlight = Math.max(peakPromisesInFlight, promisesInFlight);
      peakNativeOverlap = Math.max(peakNativeOverlap, nativeOverlap);
      let pending: Promise<unknown>;
      try {
        pending = inner(stmt);
      } finally {
        // Synchronous exit: whatever the binding did, it is done by the time the call returns.
        nativeOverlap--;
      }
      return pending.finally(() => { promisesInFlight--; });
    }) as Executor['execute'];
  }

  instrument(client, 'client');
  client.transaction = (async (...args: never[]) => {
    const tx = await originalTransaction(...args);
    const scope = `tx${transactions.length + 1}`;
    transactions.push(scope);
    instrument(tx, scope);
    return tx;
  }) as Handle['transaction'];

  const startedAt = performance.now();

  return {
    finish(): WaveMeasurement {
      const wallTimeMs = performance.now() - startedAt;
      client.execute = originalExecute;
      client.transaction = originalTransaction;
      return {
        totalStatements: captured.length,
        clientStatements: captured.filter((entry) => entry.scope === 'client').length,
        transactionStatements: captured.filter((entry) => entry.scope !== 'client').length,
        transactionsOpened: transactions.length,
        peakPromisesInFlight,
        peakNativeOverlap,
        wallTimeMs,
      };
    },
  };
}

/**
 * #2595 AC13 — the "before/after measurement on a heavy path" the crash report asked for, re-pointed
 * at the quantity that actually discriminates. The recorded numbers land in docs/crash-forensics.md §7.
 */
describe('concurrent wave — statement volume and peak in-flight', () => {
  let dir: string;
  let db: Db;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'stmt-wave-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  });

  it('never has more than one statement inside the binding, however much the JS layer overlaps', async () => {
    const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
    const bookService = new BookService(db, log);

    const wave = measureWave(db);

    // Order-50 operations through real service code: transactional creates, bare writes, and reads.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => i).map(async (i) => {
        if (i % 5 === 0) return bookService.create({ title: `Wave ${i}`, authors: [{ name: `Author ${i % 7}` }] });
        if (i % 5 === 1) {
          return db.insert(books).values({ publicId: generatePublicId('bk'), title: `Bare ${i}`, status: 'wanted' });
        }
        return bookService.findIdsByStatus('wanted');
      }),
    );

    const measurement = wave.finish();

    // The artifact itself — AC14 copies these into the PR body and the doc section.
    console.info(`#2595 wave measurement: ${JSON.stringify(measurement)}`);

    // Non-vacuous: the wave really did run a heavy, transaction-bearing load.
    expect(measurement.totalStatements).toBeGreaterThan(50);
    expect(measurement.transactionsOpened).toBeGreaterThan(0);
    expect(measurement.transactionStatements).toBeGreaterThan(0);
    // The JS layer overlaps freely...
    expect(measurement.peakPromisesInFlight).toBeGreaterThan(1);
    // ...and none of that overlap reaches the binding. This is the whole finding.
    expect(measurement.peakNativeOverlap).toBe(1);
  });
});
