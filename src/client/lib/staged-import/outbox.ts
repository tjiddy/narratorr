import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import {
  clientSubmissionIdSchema,
  payloadDigestSchema,
  submissionSourceSchema,
  type SubmissionSource,
} from '@core/import-staging/schemas.js';

// Best-effort same-tab hint; durable import_submissions remain authoritative.
// One last-write-wins slot per source; memory remains authoritative when localStorage throws.

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
    // The memory snapshot remains authoritative.
  }
}
function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // The memory snapshot was already cleared.
  }
}

const listeners = new Set<() => void>();
const cache = new Map<SubmissionSource, OutboxRecord | null>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Memoize validated storage so useSyncExternalStore receives a stable snapshot.
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
    safeRemoveItem(keyFor(source));
    cache.set(source, null);
    return null;
  }
  const result = outboxRecordSchema.safeParse(parsed);
  if (!result.success || result.data.source !== source) {
    safeRemoveItem(keyFor(source));
    cache.set(source, null);
    return null;
  }
  cache.set(source, result.data);
  return result.data;
}

export function putOutbox(record: OutboxRecord): void {
  const validated = outboxRecordSchema.parse(record);
  cache.set(validated.source, validated);
  safeSetItem(keyFor(validated.source), JSON.stringify(validated));
  notify();
}

// expectedClientId prevents a stale callback from rewriting a newer source slot.
export function markOutboxFinalized(source: SubmissionSource, submissionId?: number, expectedClientId?: string): void {
  const current = readOutbox(source);
  if (!current) return;
  if (expectedClientId !== undefined && current.clientSubmissionId !== expectedClientId) return;
  putOutbox({ ...current, status: 'finalized', ...(submissionId !== undefined ? { submissionId } : {}) });
}

// Clear memory first; expectedClientId prevents stale callbacks from evicting newer hints.
export function evictOutbox(source: SubmissionSource, expectedClientId?: string): void {
  if (expectedClientId !== undefined) {
    const current = readOutbox(source);
    if (current && current.clientSubmissionId !== expectedClientId) return;
  }
  cache.set(source, null);
  safeRemoveItem(keyFor(source));
  notify();
}

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
