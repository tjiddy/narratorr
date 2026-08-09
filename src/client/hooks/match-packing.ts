import type { MatchCandidate } from '@/lib/api';

// Match-start and recovery requests must stay below the 1 MiB proxy body limit.
export const MATCH_CHUNK_BYTE_BUDGET = 400 * 1024; // 400 KiB, well under the 1 MiB proxy limit.
const MATCH_CHUNK_MAX_ITEMS = 1000;

const encoder = new TextEncoder();
// Reserve the request envelope; each item after the first adds a comma.
const MATCH_ENVELOPE_BYTES = encoder.encode(JSON.stringify({ books: [] })).length;

export interface PackedMatchCandidates {
  /** Every serialized `{ books: chunk }` body stays within both bounds. */
  chunks: MatchCandidate[][];
  /** Single-item bodies over budget; the engine returns `none` without calling the API. */
  oversized: MatchCandidate[];
}

export function packMatchCandidates(candidates: MatchCandidate[]): PackedMatchCandidates {
  const chunks: MatchCandidate[][] = [];
  const oversized: MatchCandidate[] = [];
  let current: MatchCandidate[] = [];
  // Track the complete serialized body, not only candidate bytes.
  let bodyBytes = MATCH_ENVELOPE_BYTES;
  for (const candidate of candidates) {
    const size = encoder.encode(JSON.stringify(candidate)).length;
    if (MATCH_ENVELOPE_BYTES + size > MATCH_CHUNK_BYTE_BUDGET) {
      oversized.push(candidate);
      continue;
    }
    const wouldExceed = bodyBytes + size + 1 > MATCH_CHUNK_BYTE_BUDGET;
    if (current.length > 0 && (wouldExceed || current.length >= MATCH_CHUNK_MAX_ITEMS)) {
      chunks.push(current);
      current = [];
      bodyBytes = MATCH_ENVELOPE_BYTES;
    }
    bodyBytes += current.length > 0 ? size + 1 : size;
    current.push(candidate);
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, oversized };
}
