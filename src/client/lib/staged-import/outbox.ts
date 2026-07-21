import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import {
  clientSubmissionIdSchema,
  payloadDigestSchema,
  submissionSourceSchema,
  type SubmissionSource,
} from '../../../core/import-staging/schemas.js';

/**
 * Best-effort, source-scoped submission outbox (#1902, F69/F12).
 *
 * This is a same-tab RECONNECTION HINT — NOT an admission gate or recovery
 * authority. The durable `import_submissions` header is authoritative; the outbox
 * only lets the current tab rejoin a poll / surface an in-flight or just-finished run
 * after a client-side remount, keyed by `clientSubmissionId`. It is a single slot per
 * source (`library` / `manual`), last-write-wins; a superseded pointer is lost
 * locally but its durable header survives in the #1894 Activity history.
 *
 * Storage is mirrored to `localStorage` but the IN-MEMORY snapshot is authoritative
 * for the session: every `getItem`/`setItem`/`removeItem` is catch-guarded (Safari
 * private mode throws from reads AND eviction), and a failed evict never resurrects a
 * surfaced record — the snapshot is set before the write is attempted. Module state
 * is exposed through `useSyncExternalStore` so surface/evict transitions re-render.
 */

const OUTBOX_VERSION = 1;

export const outboxRecordSchema = z
  .object({
    version: z.literal(OUTBOX_VERSION),
    clientSubmissionId: clientSubmissionIdSchema,
    source: submissionSourceSchema,
    status: z.enum(['submitting', 'finalized']),
    payloadDigest: payloadDigestSchema,
    expectedCount: z.number().int().positive(),
    submissionId: z.number().int().positive().optional(),
  })
  .strict();
export type OutboxRecord = z.infer<typeof outboxRecordSchema>;

function keyFor(source: SubmissionSource): string {
  return `narratorr:import-outbox:${source}`;
}

// ── Catch-guarded storage primitives (F12) ──────────────────────────────────
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota exceeded / storage unavailable — the in-memory snapshot still holds.
  }
}
function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // eviction can throw too — non-fatal; the in-memory snapshot is already null.
  }
}

// ── Module external store ────────────────────────────────────────────────────
const listeners = new Set<() => void>();
const cache = new Map<SubmissionSource, OutboxRecord | null>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Read + validate the stored record for a source, evicting anything corrupt,
 * unknown-version, or schema-invalid without throwing into render. Result is memoized
 * so `useSyncExternalStore` sees a stable snapshot reference until a mutation.
 */
export function readOutbox(source: SubmissionSource): OutboxRecord | null {
  if (cache.has(source)) return cache.get(source) ?? null;
  const raw = safeGetItem(keyFor(source));
  if (!raw) {
    cache.set(source, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — evict and ignore.
    safeRemoveItem(keyFor(source));
    cache.set(source, null);
    return null;
  }
  const result = outboxRecordSchema.safeParse(parsed);
  // Unknown version / invalid uuid-digest-status / wrong source → evict + ignore.
  if (!result.success || result.data.source !== source) {
    safeRemoveItem(keyFor(source));
    cache.set(source, null);
    return null;
  }
  cache.set(source, result.data);
  return result.data;
}

/** Persist (create-or-replace) the single hint for a source. Storage failure is non-fatal. */
export function putOutbox(record: OutboxRecord): void {
  const validated = outboxRecordSchema.parse(record);
  cache.set(validated.source, validated);
  safeSetItem(keyFor(validated.source), JSON.stringify(validated));
  notify();
}

/** Advance the hint to `finalized`, optionally stamping the now-known durable id. No-op if absent. */
export function markOutboxFinalized(source: SubmissionSource, submissionId?: number): void {
  const current = readOutbox(source);
  if (!current) return;
  putOutbox({ ...current, status: 'finalized', ...(submissionId !== undefined ? { submissionId } : {}) });
}

/** Evict the hint. The in-memory snapshot is nulled BEFORE the (guarded) storage write. */
export function evictOutbox(source: SubmissionSource): void {
  cache.set(source, null);
  safeRemoveItem(keyFor(source));
  notify();
}

/** React binding — re-renders on any surface/evict transition for this source. */
export function useOutbox(source: SubmissionSource): OutboxRecord | null {
  return useSyncExternalStore(
    subscribe,
    () => readOutbox(source),
    () => null,
  );
}

/** Test-only: drop the in-memory memo so a fresh storage read is forced. */
export function __resetOutboxCache(): void {
  cache.clear();
}
