import type { AttentionSubmission } from '@/lib/api';

/** `n → "n noun(s)"` — the deterministic singular/plural count formula (F54). */
export function pluralCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Map the server's attention classification + counts to the deterministic banner
 * copy (#1894, F54). One home so the templates cannot drift across the three
 * banner hosts. Classification is server-authoritative — this never re-derives kind.
 */
export function attentionCopy(data: AttentionSubmission): string {
  if (data.attention.kind === 'abandoned') {
    return `${data.receivedCount} of ${data.expectedCount} received — nothing was imported`;
  }
  const holds = pluralCount(data.attention.held, 'hold');
  const failures = pluralCount(data.attention.failed, 'failure');
  if (data.attention.held > 0 && data.attention.failed > 0) {
    return `Import finished with ${holds} and ${failures}`;
  }
  if (data.attention.failed > 0) return `Import finished with ${failures}`;
  return `Import finished with ${holds}`;
}
