import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
import { fetchApi, URL_BASE } from './client.js';

/**
 * One entry of the `ambiguous` candidate list. `index` is SERVER-ISSUED and valid only for
 * the response that produced it — the route rebuilds it from a live `readdir` on every
 * `/state`, so it is a positional token, never a stable identity (#1963 AC22).
 */
export interface CompanionEbookCandidate {
  index: number;
  filename: string;
}

/**
 * Mirrors the server's `CompanionEbookStateResponse` (`src/server/routes/companion-ebook.ts`)
 * field for field, INCLUDING every nullable. The DB CHECKs make `filename`/`sizeBytes`
 * non-null per status and `validationCode` non-null for `invalid`, but the wire type does not
 * carry that guarantee — so the panel degrades honestly instead of asserting it away (AC33).
 */
export interface CompanionEbookState {
  status: CompanionEbookStatus;
  filename: string | null;
  sizeBytes: number | null;
  validationCode: string | null;
  candidateCount: number;
  selectedFilename: string | null;
  candidates: CompanionEbookCandidate[];
}

/**
 * Its own module rather than an addition to `books.ts` (already 449 raw lines), registered in
 * `apiModules` so `api-collision.test.ts` covers it automatically.
 *
 * There is deliberately NO `getCompanionEbookMetadata`: the chapter count is cut from #1963
 * because `/metadata` never reports which file it read, so its response cannot be bound to the
 * `/state` row rendered beside it. Adding an unused helper would invite exactly that read.
 */
export const companionEbookApi = {
  getCompanionEbookState: (bookId: number) =>
    fetchApi<CompanionEbookState>(`/books/${bookId}/companion-epub/state`),

  /** The body is `{ index }` and nothing else — the route's schema is `.strict()`. */
  putCompanionEbookSelection: (bookId: number, index: number) =>
    fetchApi<CompanionEbookState>(`/books/${bookId}/companion-epub/selection`, {
      method: 'PUT',
      body: JSON.stringify({ index }),
    }),

  /**
   * A real URL for a real `<a download>`, not a fetch-to-blob. `URL_BASE` is mandatory: a bare
   * `/api/...` href silently breaks every sub-path deployment (`backups.ts` precedent).
   */
  getCompanionEbookDownloadUrl: (bookId: number) =>
    `${URL_BASE}/api/books/${bookId}/companion-epub`,
};
