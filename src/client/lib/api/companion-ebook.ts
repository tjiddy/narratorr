import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
import type { EpubMetadata, EpubTocEntry } from '@core/epub/result.js';
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
 * Mirrors the server's metadata `200` field for field, INCLUDING `toc: null` — "we could not
 * read one", never zero chapters. There is deliberately no `chapterCount`: the panel derives it
 * from `toc.length`, and a second field computed from the array beside it is a drift seam.
 */
export interface CompanionEbookMetadata {
  /**
   * The STORED basename the request's gate resolved (#2022) — what the server declares it read.
   * The panel matches it against the `/state` row it renders beside and discards a response that
   * does not agree, which is the whole reason this helper exists.
   */
  filename: string;
  metadata: EpubMetadata;
  toc: EpubTocEntry[] | null;
}

/**
 * Its own module rather than an addition to `books.ts` (already 449 raw lines), registered in
 * `apiModules` so `api-collision.test.ts` covers it automatically.
 */
export const companionEbookApi = {
  getCompanionEbookState: (bookId: number) =>
    fetchApi<CompanionEbookState>(`/books/${bookId}/companion-epub/state`),

  /**
   * #2022 — the OPF fields and the TOC, plus the basename the server read.
   *
   * The two routes read `companion_ebooks` INDEPENDENTLY and a reconcile can commit between
   * them, so a response can legitimately describe a file other than the one `/state` just
   * reported. That is why this exists as its own read at all rather than being folded into
   * `/state`: option 2 of #2022 — the server declares what it read, and the caller discards a
   * response that does not match the row it is rendering. Nothing in the request identifies the
   * expected file; the binding is entirely in the response.
   */
  getCompanionEbookMetadata: (bookId: number) =>
    fetchApi<CompanionEbookMetadata>(`/books/${bookId}/companion-epub/metadata`),

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

  /**
   * #2034 — force a re-judgement of this book's companion ebook. The server answers `202`
   * BEFORE the reconcile runs (fire-and-forget), so a success here means "queued", never
   * "done": the caller must re-read `/state` to observe the new verdict, and immediately
   * refetching on the 202 races the reconcile. No body, no response payload.
   */
  refreshCompanionEbook: (bookId: number) =>
    fetchApi<void>(`/books/${bookId}/companion-epub/refresh`, { method: 'POST' }),
};
