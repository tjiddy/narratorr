import { formatBytes } from '@/lib/api';

type Reason = Record<string, unknown> | null;
type IndexerMap = Map<number, string>;

/** Capitalizes the first character of a string. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Returns false for null or empty-object reasons (treat {} same as null for toggle visibility). */
export function hasReasonContent(reason: Reason): boolean {
  if (reason == null) return false;
  return Object.values(reason).some(v => v != null);
}

/** Returns an inline summary string for grabbed events, null for all others. */
export function getEventSummary(eventType: string, reason: Reason, indexerMap: IndexerMap): string | null {
  if (reason == null || eventType !== 'grabbed') return null;
  const indexerId = reason.indexerId as number | undefined;
  const size = reason.size as number | undefined;
  const protocol = reason.protocol as string | undefined;

  const indexerName = indexerId != null ? (indexerMap.get(indexerId) ?? String(indexerId)) : null;
  const protocolLabel = protocol ? capitalize(protocol) : null;
  const sizeLabel = size != null ? formatBytes(size) : null;

  const parts: string[] = [];
  if (indexerName) parts.push(`from ${indexerName}`);
  if (protocolLabel) parts.push(`(${protocolLabel})`);
  if (sizeLabel) parts.push(`· ${sizeLabel}`);
  return parts.length > 0 ? parts.join(' ') : null;
}
