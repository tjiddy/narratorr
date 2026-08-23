import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './src/db/migrate.js';
import { createDb } from './src/db/client.js';

const dir = mkdtempSync(join(tmpdir(), 'probe-'));
const file = join(dir, 'n.db');
await runMigrations(file);
const db = createDb(file);
const client = db.$client as any;

function cte(rows: number, label: string) {
  return `WITH RECURSIVE gen(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM gen WHERE x < ${rows}) SELECT '${label}' AS label, count(*) AS n, sum(x) AS s FROM gen`;
}

async function heartbeat<T>(fn: () => Promise<T>) {
  let ticks = 0;
  let running = true;
  const beat = () => { if (!running) return; ticks++; setImmediate(beat); };
  setImmediate(beat);
  await new Promise((r) => setImmediate(r));
  const start = ticks;
  const t0 = performance.now();
  const value = await fn();
  const durationMs = performance.now() - t0;
  running = false;
  return { value, durationMs, ticksDuring: ticks - start };
}

for (const n of [100_000, 500_000, 1_000_000, 2_000_000]) {
  const r = await heartbeat(() => client.execute(cte(n, 'A')));
  console.log('rows', n, 'dur', r.durationMs.toFixed(1), 'ticks', r.ticksDuring, JSON.stringify(r.value.rows[0]));
}

// idle calibration
const idle = await heartbeat(() => new Promise((r) => setTimeout(r, 200)));
console.log('idle 200ms ticks', idle.ticksDuring, idle.durationMs.toFixed(1));

// sum vs max
const N = 1_000_000;
const a = await heartbeat(() => client.execute(cte(N, 'A')));
const b = await heartbeat(() => client.execute(cte(N, 'B')));
const t0 = performance.now();
await Promise.all([client.execute(cte(N, 'A')), client.execute(cte(N, 'B'))]);
const both = performance.now() - t0;
console.log('a', a.durationMs.toFixed(1), 'b', b.durationMs.toFixed(1), 'both', both.toFixed(1), 'ratio to sum', (both / (a.durationMs + b.durationMs)).toFixed(2));

// trace
const orig = client.execute.bind(client);
const trace: { tag: string; phase: string; at: number }[] = [];
client.execute = (stmt: any, ...rest: any[]) => {
  const text = typeof stmt === 'string' ? stmt : stmt?.sql ?? '';
  const tag = /'([AB])' AS label/.exec(text)?.[1] ?? '?';
  trace.push({ tag, phase: 'enter', at: performance.now() });
  const p = orig(stmt, ...rest);
  trace.push({ tag, phase: 'exit', at: performance.now() });
  return p;
};
await Promise.all([client.execute(cte(N, 'A')), client.execute(cte(N, 'B'))]);
console.log(trace.map((t) => `${t.phase}${t.tag}`).join(','));
console.log('spanA', (trace[1]!.at - trace[0]!.at).toFixed(1), 'spanB', (trace[3]!.at - trace[2]!.at).toFixed(1));
client.execute = orig;

// tx handle
const tx = await client.transaction();
const txOrig = tx.execute.bind(tx);
const txTrace: { tag: string; phase: string; at: number }[] = [];
tx.execute = (stmt: any, ...rest: any[]) => {
  const text = typeof stmt === 'string' ? stmt : stmt?.sql ?? '';
  const tag = /'([AB])' AS label/.exec(text)?.[1] ?? '?';
  txTrace.push({ tag, phase: 'enter', at: performance.now() });
  const p = txOrig(stmt, ...rest);
  txTrace.push({ tag, phase: 'exit', at: performance.now() });
  return p;
};
const txHb = await heartbeat(() => Promise.all([tx.execute(cte(N, 'A')), tx.execute(cte(N, 'B'))]));
console.log('tx trace', txTrace.map((t) => `${t.phase}${t.tag}`).join(','), 'ticks', txHb.ticksDuring, 'dur', txHb.durationMs.toFixed(1));
console.log('tx spanA', (txTrace[1]!.at - txTrace[0]!.at).toFixed(1));
await tx.rollback();
client.close?.();
console.log('done');
