import type { AttentionSubmission } from '@/lib/api';

export function pluralCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Uses the server's attention classification so copy stays consistent across banner hosts. */
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
