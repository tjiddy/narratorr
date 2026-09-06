import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 * a verdict by measurement: it expires loudly. See docs/crash-forensics.md §7 and §8.
 */
const MEASURED_AGAINST = '@libsql/client 0.18.0 / libsql 0.5.29 / drizzle-orm 0.45.2';

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

type NativeMethod = (this: object, ...args: unknown[]) => unknown;
type NativePrototype = Record<string, NativeMethod>;

/**
 * The binding the client actually calls, resolved through the client's own dependency tree so the
 * prototypes patched below are the instances `@libsql/client` holds — a second copy of `libsql`
 * would be patched perfectly and observe nothing.
 *
 * The probe statement stays referenced for the module's lifetime on purpose: libsql 0.5.29 crashes
 * when a Statement is finalized before the Database it was prepared on (docs/crash-forensics.md §8),
 * and a throwaway in-memory pair would hand that ordering to the garbage collector.
 */
const nativeBinding = (() => {
  const requireFromClient = createRequire(createRequire(import.meta.url).resolve('@libsql/client'));
  const Database = requireFromClient('libsql') as new (path: string) => { prepare: (sql: string) => object };
  const probeDb = new Database(':memory:');
  const probeStmt = probeDb.prepare('SELECT 1');
  return {
    database: Database.prototype as NativePrototype,
    statement: Object.getPrototypeOf(probeStmt) as NativePrototype,
    keepAlive: [probeDb, probeStmt],
  };
})();

const labelOf = (sql: unknown) => /'([A-Z])' AS label/.exec(typeof sql === 'string' ? sql : '')?.[1] ?? '?';

/**
 * Records enter/exit SYNCHRONOUSLY around each call into the native binding — `Database.prepare`
 * and `Statement.all`/`run`, which is everything `@libsql/client`'s `executeStmt` does with it. This
 * is the observation point that answers the question, and it is deliberately below the client:
 * since 0.18.0 `client.execute` awaits a pool acquisition before it executes, so a span recorded
 * around `client.execute` reads ~0 while the statement itself still blocks the thread for its whole
 * duration. Below the facade, a synchronous binding reads full spans and an executor whose work
 * happens elsewhere reads none — the A3 counterfactuals pin that this probe can report absence.
 *
 * A statement's label is captured at `prepare` (the only call that sees the SQL) and carried to its
 * `all`/`run` through a WeakMap, so both native spans of one statement share a label.
 */
function traceNativeSpans(): SpanTrace {
  const events: SpanEvent[] = [];
  const labels = new WeakMap<object, string>();
  const restores: Array<() => void> = [];

  const wrap = (proto: NativePrototype, name: string, label: (self: object, args: unknown[]) => string, tag?: (self: object, args: unknown[], result: unknown) => void) => {
    const original = proto[name];
    if (typeof original !== 'function') throw new Error(`native binding has no ${name}()`);
    proto[name] = function (this: object, ...args: unknown[]) {
      const l = label(this, args);
      events.push({ label: l, phase: 'enter', at: performance.now() });
      try {
        const result = original.apply(this, args);
        tag?.(this, args, result);
        return result;
      } finally {
        events.push({ label: l, phase: 'exit', at: performance.now() });
      }
    };
    restores.push(() => { proto[name] = original; });
  };

  wrap(nativeBinding.database, 'prepare', (_self, args) => labelOf(args[0]), (_self, args, stmt) => {
    if (stmt !== null && typeof stmt === 'object') labels.set(stmt, labelOf(args[0]));
  });
  wrap(nativeBinding.statement, 'all', (self) => labels.get(self) ?? '?');
  wrap(nativeBinding.statement, 'run', (self) => labels.get(self) ?? '?');

  return { events, restore: () => { for (const restore of restores.reverse()) restore(); } };
}

/**
 * True when no native call began while another was still inside the binding. The order
 * `enterA,exitA,enterB,exitB` that an execute-level trace used to assert is identical for a sync and
 * an async client; strict alternation at the native boundary is the claim itself.
 */
function neverNested(events: SpanEvent[]): boolean {
  let open: string | null = null;
  for (const event of events) {
    if (event.phase === 'enter') {
      if (open !== null) return false;
      open = event.label;
    } else {
      if (open !== event.label) return false;
      open = null;
    }
  }
  return open === null;
}

/** Labels in the order their first native call began. */
const labelOrder = (events: SpanEvent[]) => [...new Set(events.filter((event) => event.phase === 'enter').map((event) => event.label))];

/** Total native time for a label across its `prepare` and `all`/`run` spans; 0 when nothing reached the binding. */
function spanOf(events: SpanEvent[], label: string): number {
  let total = 0;
  let enteredAt: number | null = null;
  for (const event of events) {
    if (event.label !== label) continue;
    if (event.phase === 'enter') enteredAt = event.at;
    else if (enteredAt !== null) {
      total += event.at - enteredAt;
      enteredAt = null;
    }
  }
  return total;
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
    it('fills the concurrent pair’s wall time with the two statements’ own native spans', async () => {
      // Within ONE window, never across two: every cross-window wall-clock formulation of this
      // claim flaked on CI, where a second workflow runs this whole suite concurrently on a
      // 2-core runner (separate-window best-of read both<one; interleaved best-of did too).
      // Here numerator and denominator come from the same timeline, so a mid-span preemption
      // charges both sides: serial execution fills the pair's wall with the two spans (~1.0),
      // genuinely overlapping native work would exceed it (~2.0), an executor that never enters
      // the binding on this thread leaves it empty (~0 — the A3 counterfactual below pins that
      // this assertion can red).
      const trace = traceNativeSpans();
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

  describe('A1/A2 — the native span covers the whole statement', () => {
    it('never enters a second statement on the connection before the first has exited', async () => {
      const trace = traceNativeSpans();
      try {
        await Promise.all([
          client.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
          client.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
        ]);
      } finally {
        trace.restore();
      }

      expect(labelOrder(trace.events)).toEqual(['A', 'B']);
      expect(neverNested(trace.events)).toBe(true);
      // The whole statement happened inside one synchronous native call — a driver whose work ran
      // off this thread would leave a span of roughly nothing.
      expect(spanOf(trace.events, 'A')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      expect(spanOf(trace.events, 'B')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
    });

    it('shows the same signature on a tx handle, which is where drizzle sends in-transaction queries', async () => {
      const tx = await client.transaction();
      const trace = traceNativeSpans();
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

      expect(labelOrder(trace.events)).toEqual(['A', 'B']);
      expect(neverNested(trace.events)).toBe(true);
      expect(spanOf(trace.events, 'A')).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      expect(measured.ticksDuring).toBe(0);
      expect(measured.ticksIdle).toBeGreaterThan(100);
    });
  });

  describe('A3 — counterfactual: the probe can detect overlap', () => {
    /**
     * Everything above asserts an absence. Absence assertions are worthless unless the observation
     * point can produce the presence, so the same two probes run against a client whose `execute`
     * genuinely awaits and never enters the binding on this thread — the shape a future async driver
     * would have — and both must flip.
     */
    const asyncStub = (): Executor => ({
      execute: async (stmt: string) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { rows: [{ label: labelOf(stmt) }] };
      },
    });

    it('reports loop ticks and a near-zero native span for a genuinely asynchronous execute', async () => {
      const stub = asyncStub();

      const measured = await measureOccupancy(() => stub.execute(rowGenerator(WORKLOAD_ROWS, 'A')));
      expect(measured.durationMs).toBeGreaterThan(OCCUPANCY_FLOOR_MS);
      // The assertion the real client passes — `ticksDuring === 0` — is false here, so it is load-bearing.
      expect(measured.ticksDuring).toBeGreaterThan(100);

      const trace = traceNativeSpans();
      try {
        await Promise.all([
          stub.execute(rowGenerator(WORKLOAD_ROWS, 'A')),
          stub.execute(rowGenerator(WORKLOAD_ROWS, 'B')),
        ]);
      } finally {
        trace.restore();
      }

      // The span assertion the real client passes is false here too: nothing reached the binding.
      expect(spanOf(trace.events, 'A')).toBeLessThan(OCCUPANCY_FLOOR_MS);
      expect(spanOf(trace.events, 'B')).toBeLessThan(OCCUPANCY_FLOOR_MS);
    });

    it('leaves the concurrent pair’s wall time empty of native spans', async () => {
      const stub = asyncStub();

      const trace = traceNativeSpans();
      const startedAt = performance.now();
      try {
        await Promise.all([stub.execute(rowGenerator(1, 'A')), stub.execute(rowGenerator(1, 'B'))]);
      } finally {
        trace.restore();
      }
      const wall = performance.now() - startedAt;

      // The span-fill assertion the real client passes (> 0.75) is false here — overlapping awaits
      // spend their wall time off the binding, so the spans fill ~none of it.
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
  /** Wall time the process spent inside native binding calls. */
  bindingOccupancyMs: number;
  /** `bindingOccupancyMs / wallTimeMs`. Near 1 when the binding blocks; near 0 when it does not. */
  bindingOccupancyRatio: number;
  /** Longest single uninterruptible native call — the event loop could not turn for this long. */
  maxBlockMs: number;
  /**
   * Median single native call. Robust to OS preemption charging a scheduling quantum to a span
   * (which corrupts a few samples, never a majority) — the sum/ratio figures are not.
   */
  medianBlockMs: number;
  wallTimeMs: number;
}

type WaveTarget = Executor & { transaction: (...args: never[]) => Promise<Executor> };

/**
 * The share of wall time the process must have spent blocked inside the binding for the wave to
 * count as serial. Measured, not guessed: at the native boundary the real client reads ~0.7 across
 * runs (the rest is drizzle query building, result mapping and service JS between native calls) and
 * the off-binding executor below reads exactly 0. The floor sits ~3x under the real reading, so CI
 * load — which inflates wall time and therefore pushes the real ratio DOWN — has room before it
 * false-reds.
 */
const WAVE_OCCUPANCY_FLOOR = 0.2;

/** An executor with the shape a genuinely asynchronous driver would have: nothing enters the binding on this thread. */
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
 * discriminates — how much of the wave's wall time the process spent blocked inside native calls.
 * A synchronous binding drives that toward 1; an executor whose work happens off this thread drives
 * it toward 0, which is what the counterfactual wave below demonstrates.
 *
 * Statement volume is still counted at `execute` and `transaction`, because drizzle dispatches
 * in-transaction queries through the handle and a client-only count sees them zero times. Occupancy
 * comes from the native boundary, where the client's async facade cannot hide it.
 */
function measureWave(target: WaveTarget) {
  const originalExecute = target.execute.bind(target);
  const originalTransaction = target.transaction.bind(target);
  const native = traceNativeSpans();

  const captured: { scope: string }[] = [];
  const transactions: string[] = [];
  let inFlight = 0;
  let peakStatementsInFlight = 0;

  function instrument(executor: Executor, scope: string): void {
    const inner = executor.execute.bind(executor);
    executor.execute = ((stmt: string) => {
      captured.push({ scope });
      inFlight++;
      peakStatementsInFlight = Math.max(peakStatementsInFlight, inFlight);
      return inner(stmt).finally(() => { inFlight--; });
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
      native.restore();

      const blocks: number[] = [];
      let enteredAt: number | null = null;
      for (const event of native.events) {
        if (event.phase === 'enter') enteredAt = event.at;
        else if (enteredAt !== null) {
          blocks.push(event.at - enteredAt);
          enteredAt = null;
        }
      }
      const bindingOccupancyMs = blocks.reduce((sum, block) => sum + block, 0);

      return {
        totalStatements: captured.length,
        clientStatements: captured.filter((entry) => entry.scope === 'client').length,
        transactionStatements: captured.filter((entry) => entry.scope !== 'client').length,
        transactionsOpened: transactions.length,
        peakStatementsInFlight,
        bindingOccupancyMs,
        bindingOccupancyRatio: bindingOccupancyMs / wallTimeMs,
        maxBlockMs: blocks.reduce((max, block) => Math.max(max, block), 0),
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
    // The discriminating reading: a large share of the wave was the process blocked inside native
    // calls, one at a time. The counterfactual wave below drives this same figure to 0.
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
    // ...and yet nothing reached the binding. That is what makes it evidence: an execute-level
    // wrapper that awaited would read the full statement duration instead. Median, not the
    // sum/ratio: on saturated 2-core CI runners (two workflows run this suite concurrently per
    // push) the OS deschedules the process mid-span and charges whole scheduling quanta to a few
    // samples — the ratio read 0.13 and then 0.43 there against a 0.02 idle baseline. A median of
    // 50 spans needs 26 corrupted samples to move, which contention does not produce.
    expect(measurement.medianBlockMs).toBeLessThan(1);
    expect(measurement.bindingOccupancyMs).toBe(0);
  });
});
