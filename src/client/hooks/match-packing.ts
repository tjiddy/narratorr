import type { MatchCandidate } from '@/lib/api';

/**
 * Byte-budgeted chunking for match-start candidates (#1831). Candidates are
 * `{ path, title, author }` (~250 B, no metadata blob) so a large scan crosses the
 * 1 MiB body limit near ~4,000 books — enough for a big library to 413 at match-start
 * before confirm is ever reached. Every remainder run (#1864) re-packs its result-less
 * candidates through here too, so a multi-chunk recovery stays within the same budget.
 */
export const MATCH_CHUNK_BYTE_BUDGET = 400 * 1024; // 400 KiB — well under 1 MiB
const MATCH_CHUNK_MAX_ITEMS = 1000; // secondary count bound

/** Reused across every candidate serialization instead of ~5k per-pack allocations (#1833). */
const encoder = new TextEncoder();
/**
 * Byte cost of the `{ books: [...] }` request envelope for an EMPTY array —
 * `{"books":[]}` = 12 bytes. Reserved up front so the budget bounds what actually
 * crosses the wire, not the bare candidate array (#1833). Each item after the first
 * in a chunk additionally costs a `,` separator, accounted for below.
 */
const MATCH_ENVELOPE_BYTES = encoder.encode(JSON.stringify({ books: [] })).length;

export interface PackedMatchCandidates {
  /** Byte- and count-bounded chunks; every `{ books: chunk }` body is within budget. */
  chunks: MatchCandidate[][];
  /**
   * Candidates whose OWN `{ books: [candidate] }` body already exceeds the budget (#1864 F15).
   * These can never be sent within budget, so they are diverted here rather than emitted in an
   * over-budget request that would 413 at the proxy. The engine surfaces them as unmatchable
   * (a `none` result) instead of calling the API. Structurally remote — match candidates are
   * `{ path, title, author }` from filesystem-bounded folder names — but the packer guarantees
   * the budget contract unconditionally.
   */
  oversized: MatchCandidate[];
}

export function packMatchCandidates(candidates: MatchCandidate[]): PackedMatchCandidates {
  const chunks: MatchCandidate[][] = [];
  const oversized: MatchCandidate[] = [];
  let current: MatchCandidate[] = [];
  // Track the serialized size of the whole `{ books: current }` body, not just the
  // summed candidate bytes — the wire body is `JSON.stringify({ books: chunk })` (#1833).
  let bodyBytes = MATCH_ENVELOPE_BYTES;
  for (const candidate of candidates) {
    const size = encoder.encode(JSON.stringify(candidate)).length;
    // A candidate whose own single-item body (`{"books":[candidate]}` = envelope + size, no
    // comma) already exceeds the budget can never fit any chunk — divert it (F15).
    if (MATCH_ENVELOPE_BYTES + size > MATCH_CHUNK_BYTE_BUDGET) {
      oversized.push(candidate);
      continue;
    }
    // Adding to a non-empty chunk also costs a separating comma.
    const wouldExceed = bodyBytes + size + 1 > MATCH_CHUNK_BYTE_BUDGET;
    if (current.length > 0 && (wouldExceed || current.length >= MATCH_CHUNK_MAX_ITEMS)) {
      chunks.push(current);
      current = [];
      bodyBytes = MATCH_ENVELOPE_BYTES;
    }
    // First item in a chunk pays no comma; subsequent items pay one.
    bodyBytes += current.length > 0 ? size + 1 : size;
    current.push(candidate);
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, oversized };
}
