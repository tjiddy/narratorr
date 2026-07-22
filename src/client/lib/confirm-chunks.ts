import type { StagedImportItem } from '../../core/import-staging/schemas.js';

/**
 * Byte-budgeted chunk packer for the Library/Manual Import confirm POST (#1831).
 *
 * A first-run user with a large library selects hundreds–thousands of
 * `ImportConfirmItem`s, each carrying an unbounded `metadata` pass-through blob
 * (Audible descriptions run 1–4 KB+). Shipping them in one request blows past the
 * 1 MiB body limit — Fastify's default and, more importantly, nginx's default
 * `client_max_body_size` (which 413s at the proxy before Fastify is ever reached).
 *
 * So the client splits the selection into chunks packed greedily by *serialized
 * byte size* and POSTs them sequentially. Every emitted chunk stays under
 * {@link CHUNK_BYTE_BUDGET}; an item larger than the budget but under
 * {@link MAX_SINGLE_ITEM_BYTES} ships alone in its own chunk (still under 1 MiB
 * once the `{ books, mode }` envelope is added). An item whose *own* serialized
 * size exceeds {@link MAX_SINGLE_ITEM_BYTES} is diverted to `tooLarge` and is
 * NEVER packed or sent — no request that leaves the client can exceed 1 MiB by
 * construction, so the guarantee does not rely on any server-side or proxy limit.
 */

/** Target per-chunk serialized size. Well under 1 MiB so many items batch per request. */
export const CHUNK_BYTE_BUDGET = 400 * 1024; // 400 KiB
/**
 * Transport ceiling for a single item. Comfortably below the 1 MiB proxy floor once
 * the `{ books, mode }` request envelope is added, so a lone item of this size still
 * ships. An item above this is diverted to `tooLarge` pre-flight (never sent).
 */
export const MAX_SINGLE_ITEM_BYTES = 900 * 1024; // 900 KiB
/** Secondary bound so a chunk of tiny items never balloons the request item count. */
export const MAX_CHUNK_ITEMS = 200;

/** Reused across every item serialization instead of ~5k per-pack allocations (#1833). */
const encoder = new TextEncoder();

/**
 * A staged PUT row — `{ ordinal, item }` where `item` is the WHOLE parsed staged
 * item. This is the on-the-wire shape the `PUT :id/items` route parses (F70), so the
 * staged chunker must budget the FULL `{ items: [{ ordinal, item }] }` request body,
 * NOT the bare item sum the legacy confirm packer measured.
 */
export interface StagedPutRow {
  ordinal: number;
  item: StagedImportItem;
}

/**
 * Serialized UTF-8 byte size of the FULL `{ items: [...] }` PUT request body (#1902,
 * F70). This is exact — `JSON.stringify({ items: rows })` is the wrapper plus the
 * comma-joined rows — so a packer that keeps this under budget cannot emit a request
 * that overflows the transport ceiling.
 */
export function stagedRequestBytes(rows: readonly StagedPutRow[]): number {
  return encoder.encode(JSON.stringify({ items: rows })).length;
}

/**
 * Byte-budget the staged PUT into sequential `{ items: [{ ordinal, item }] }`
 * requests (#1902, F70). Every row's `item` already cleared the per-item ceiling in
 * classification (oversize rows were excluded pre-header), so each row ships; the
 * packer only bounds each REQUEST by {@link CHUNK_BYTE_BUDGET} (measured over the full
 * envelope) and {@link MAX_CHUNK_ITEMS}. A lone row larger than the budget ships alone
 * in its own request (still under 1 MiB once wrapped, by the per-item ceiling).
 */
export function packStagedChunks(rows: readonly StagedPutRow[]): StagedPutRow[][] {
  const chunks: StagedPutRow[][] = [];
  let current: StagedPutRow[] = [];

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  };

  for (const row of rows) {
    // Would adding this row push the current request over budget or the count bound?
    const overflowsBudget = current.length > 0 && stagedRequestBytes([...current, row]) > CHUNK_BYTE_BUDGET;
    const overflowsCount = current.length >= MAX_CHUNK_ITEMS;
    if (overflowsBudget || overflowsCount) flush();
    current.push(row);
  }
  flush();

  return chunks;
}
