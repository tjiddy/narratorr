import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { removeDirTolerant } from '../server/__tests__/windows-fs.js';
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
 * Heartbeat loops that are still rearming themselves. A loop deregisters only when it observes its
 * own stop flag, so this counter tracks the real thing a leak would leave behind rather than merely
 * echoing the line that sets the flag.
 */
let liveHeartbeats = 0;

/** Settles once every heartbeat that was asked to stop has actually run and deregistered. */
const drainHeartbeats = () => new Promise((resolve) => setImmediate(resolve));

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
      if (!running) {
        liveHeartbeats--;
        return;
      }
      ticks++;
      setImmediate(beat);
    };
    liveHeartbeats++;
    setImmediate(beat);
    // Let the loop reach steady state before the window opens.
    await new Promise((resolve) => setImmediate(resolve));
    const before = ticks;
    const startedAt = performance.now();
    try {
      const value = await body();
      return { value, durationMs: performance.now() - startedAt, ticksDuring: ticks - before };
    } finally {
      // In `finally`, not after the await: a rejecting body would otherwise leave `beat` rearming
      // itself forever, turning an intended red into a worker that spins instead of failing.
      running = false;
    }
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
    // Close before removing: Windows keeps the DB file locked until the client closes, which is the
    // same reason migrate.ts closes in a `finally`.
    db.$client.close();
    // Windows releases the libSQL handle lazily even after close (#2599's class) — tolerate it.
    removeDirTolerant(dir);
  });

  describe('A1 — event-loop occupancy', () => {
    it('does not let the event loop tick once while a statement is inside the binding', async () => {
      const measured = await measureOccupancy(() => client.execute(rowGenerator(WORKLOAD_ROWS, 'A')));

      // Guards the reading against a workload that finished inside one tick: without this the zero
      // below would be true of any trivially fast statement and would prove nothing.
      expect(measured.durationMs).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      // The same window, idle: the loop was live and free to tick throughout.
      expect(measured.ticksIdle).toBeGreaterThan(100);

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

    it('stops the heartbeat when the measured statement rejects', async () => {
      // A driver or SQL regression makes the probe reject. The heartbeat must come down with it —
      // otherwise the intended red is replaced by a worker spinning on setImmediate forever.
      await expect(measureOccupancy(() => client.execute('SELECT * FROM no_such_table')))
        .rejects.toThrow(/no such table/);

      await drainHeartbeats();
      expect(liveHeartbeats).toBe(0);
    });
  });

  describe('A1 — two concurrent statements cost the sum, never the max', () => {
    it('fills the concurrent pair’s wall time with the two statements’ own spans', async () => {
      // Within ONE window, never across two: every cross-window wall-clock formulation of this
      // claim flaked on CI, where a second workflow runs this whole suite concurrently on a
      // 2-core runner (separate-window best-of read both<one; interleaved best-of did too).
      // Here numerator and denominator come from the same timeline, so a mid-span preemption
      // charges both sides: serial execution fills the pair's wall with the two spans (~1.0),
      // genuinely overlapping native work would exceed it (~2.0), an async driver leaves it
      // empty (~0 — the A3 counterfactual below pins that this assertion can red).
      const trace = traceSyncSpans(client);
      const startedAt = performance.now();
      try {
        await Promise.all([
          client.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
          client.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
        ]);
      } finally {
        trace.restore();
      }
      const wall = performance.now() - startedAt;
      const spanSum = spanOf(trace.events, 'A') + spanOf(trace.events, 'B');

      expect(spanOf(trace.events, 'A')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      expect(spanSum / wall).toBeGreaterThan(0.75);
      expect(spanSum / wall).toBeLessThan(1.2);
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
      expect(measured.ticksIdle).toBeGreaterThan(100);
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
      expect(measured.ticksDuring).toBeGreaterThan(100);

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

    it('leaves the concurrent pair’s wall time empty of synchronous spans', async () => {
      const stub = asyncStub();

      const trace = traceSyncSpans(stub);
      const startedAt = performance.now();
      await Promise.all([stub.execute(rowGenerator(1, 'A')), stub.execute(rowGenerator(1, 'B'))]);
      const wall = performance.now() - startedAt;
      trace.restore();

      // The span-fill assertion the real client passes (> 0.75) is false here — overlapping awaits
      // spend their wall time off-frame, so the spans fill ~none of it.
      expect((spanOf(trace.events, 'A') + spanOf(trace.events, 'B')) / wall).toBeLessThan(0.2);
    });
  });
});

interface WaveMeasurement {
  totalStatements: number;
  clientStatements: number;
  transactionStatements: number;
  transactionsOpened: number;
  /** Peak statements outstanding at the JS layer, counted enter → settlement. */
  peakStatementsInFlight: number;
  /** Wall time the process spent inside statement call frames. */
  bindingOccupancyMs: number;
  /** `bindingOccupancyMs / wallTimeMs`. Near 1 when the binding blocks; near 0 when it does not. */
  bindingOccupancyRatio: number;
  /** Longest single uninterruptible block — the event loop could not turn for this long. */
  maxBlockMs: number;
  /**
   * Median single-call span. Robust to OS preemption charging a scheduling quantum to a span
   * (which corrupts a few samples, never a majority) — the sum/ratio figures are not.
   */
  medianBlockMs: number;
  wallTimeMs: number;
}

type WaveTarget = Executor & { transaction: (...args: never[]) => Promise<Executor> };

/**
 * The share of wall time the process must have spent blocked inside statement frames for the wave to
 * count as serial. Measured, not guessed: the real client reads 0.49-0.50 across runs (the remaining
 * half is drizzle query building and service JS between statements, not binding time) and the
 * off-frame executor below reads 0.017-0.021. The floor sits ~2.4x under the real reading and ~10x
 * over the counterfactual, so CI load — which inflates wall time and therefore pushes the real ratio
 * DOWN — has room before it false-reds.
 */
const WAVE_OCCUPANCY_FLOOR = 0.2;

/** An executor with the shape a genuinely asynchronous driver would have: nothing runs in the caller's frame. */
function asyncWaveTarget(): WaveTarget {
  const executor = (): Executor => ({
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rows: [] };
    },
  });
  return { ...executor(), transaction: async () => executor() };
}

/**
 * The peak-in-flight figure alone cannot answer "how much overlap reached the binding": a counter
 * incremented and decremented inside one synchronous frame can never exceed 1 on a single JS thread,
 * so it reads 1 for a synchronous driver AND for an asynchronous one. Occupancy is the quantity that
 * discriminates — how much of the wave's wall time the process spent blocked inside statement call
 * frames. A synchronous binding drives that toward 1; an executor whose work happens off-frame drives
 * it toward 0, which is what the counterfactual wave below demonstrates.
 *
 * Instruments `transaction` as well as `execute`, because drizzle dispatches in-transaction queries
 * through the handle and a client-only probe counts them zero times.
 */
function measureWave(target: WaveTarget) {
  const originalExecute = target.execute.bind(target);
  const originalTransaction = target.transaction.bind(target);

  const captured: { scope: string }[] = [];
  const transactions: string[] = [];
  let inFlight = 0;
  let peakStatementsInFlight = 0;
  let bindingOccupancyMs = 0;
  let maxBlockMs = 0;
  const blocks: number[] = [];

  function instrument(executor: Executor, scope: string): void {
    const inner = executor.execute.bind(executor);
    executor.execute = ((stmt: string) => {
      captured.push({ scope });
      inFlight++;
      peakStatementsInFlight = Math.max(peakStatementsInFlight, inFlight);
      const enteredAt = performance.now();
      let pending: Promise<unknown>;
      try {
        pending = inner(stmt);
      } finally {
        const block = performance.now() - enteredAt;
        bindingOccupancyMs += block;
        maxBlockMs = Math.max(maxBlockMs, block);
        blocks.push(block);
      }
      return pending.finally(() => { inFlight--; });
    }) as Executor['execute'];
  }

  instrument(target, 'client');
  target.transaction = (async (...args: never[]) => {
    const tx = await originalTransaction(...args);
    const scope = `tx${transactions.length + 1}`;
    transactions.push(scope);
    instrument(tx, scope);
    return tx;
  }) as WaveTarget['transaction'];

  const startedAt = performance.now();

  return {
    finish(): WaveMeasurement {
      const wallTimeMs = performance.now() - startedAt;
      target.execute = originalExecute;
      target.transaction = originalTransaction;
      return {
        totalStatements: captured.length,
        clientStatements: captured.filter((entry) => entry.scope === 'client').length,
        transactionStatements: captured.filter((entry) => entry.scope !== 'client').length,
        transactionsOpened: transactions.length,
        peakStatementsInFlight,
        bindingOccupancyMs,
        bindingOccupancyRatio: bindingOccupancyMs / wallTimeMs,
        maxBlockMs,
        medianBlockMs: [...blocks].sort((a, b) => a - b)[Math.floor(blocks.length / 2)] ?? 0,
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
    db.$client.close();
    // Windows releases the libSQL handle lazily even after close (#2599's class) — tolerate it.
    removeDirTolerant(dir);
  });

  it('spends the wave blocked inside the binding, however much the JS layer overlaps', async () => {
    const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
    const bookService = new BookService(db, log);

    const wave = measureWave(db.$client as unknown as WaveTarget);

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
    console.info(`#2595 wave measurement (real client): ${JSON.stringify(measurement)}`);

    // Non-vacuous: the wave really did run a heavy, transaction-bearing load.
    expect(measurement.totalStatements).toBeGreaterThan(50);
    expect(measurement.transactionsOpened).toBeGreaterThan(0);
    expect(measurement.transactionStatements).toBeGreaterThan(0);
    // The JS layer overlaps freely — this figure reads the same for a synchronous and an
    // asynchronous driver, which is exactly why it cannot be the evidence on its own.
    expect(measurement.peakStatementsInFlight).toBeGreaterThan(1);
    // The discriminating reading: almost the entire wave was the process blocked inside statement
    // frames, one at a time. The counterfactual wave below drives this same figure to ~0.
    expect(measurement.bindingOccupancyRatio).toBeGreaterThan(WAVE_OCCUPANCY_FLOOR);
  });

  it('reports collapsed occupancy for an executor whose work genuinely happens off-frame', async () => {
    // The counterfactual for the wave probe, not just for the single-statement probes: without it the
    // occupancy assertion above could be true by construction rather than by measurement.
    const target = asyncWaveTarget();
    const wave = measureWave(target);

    await Promise.all(
      Array.from({ length: 50 }, (_, i) => i).map(async (i) => {
        if (i % 5 === 0) {
          const tx = await target.transaction();
          await tx.execute(`INSERT INTO t VALUES (${i})`);
          return;
        }
        return target.execute(`SELECT ${i}`);
      }),
    );

    const measurement = wave.finish();
    console.info(`#2595 wave measurement (async counterfactual): ${JSON.stringify(measurement)}`);

    // Same statement volume, same transaction scopes, same JS-layer overlap...
    expect(measurement.totalStatements).toBe(50);
    expect(measurement.transactionsOpened).toBe(10);
    expect(measurement.transactionStatements).toBe(10);
    expect(measurement.peakStatementsInFlight).toBeGreaterThan(1);
    // ...and yet the probe reads ~nothing per call here. That is what makes it evidence: a broken
    // (await-based) wrapper would read the full statement duration instead. Median, not the
    // sum/ratio: on saturated 2-core CI runners (two workflows run this suite concurrently per
    // push) the OS deschedules the process mid-span and charges whole scheduling quanta to a few
    // samples — the ratio read 0.13 and then 0.43 there against a 0.02 idle baseline. A median of
    // 50 spans needs 26 corrupted samples to move, which contention does not produce.
    expect(measurement.medianBlockMs).toBeLessThan(1);
  });
});
