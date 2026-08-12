import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
import type { EpubMetadata, EpubTocEntry } from '@core/epub/result.js';
import { fetchApi, URL_BASE } from './client.js';

/** Server-issued `index` is positional and valid only for the response that produced it (#1963 AC22). */
export interface CompanionEbookCandidate {
  index: number;
  filename: string;
}

/** Preserve every wire nullable; DB status checks are not guarantees carried by the response type (AC33). */
export interface CompanionEbookState {
  status: CompanionEbookStatus;
  filename: string | null;
  sizeBytes: number | null;
  validationCode: string | null;
  candidateCount: number;
  selectedFilename: string | null;
  candidates: CompanionEbookCandidate[];
}

/** `toc: null` means unreadable, not zero; derive chapter count from the array to avoid drift. */
export interface CompanionEbookMetadata {
  /** Stored basename the server read; callers reject metadata that disagrees with rendered state (#2022). */
  filename: string;
  metadata: EpubMetadata;
  toc: EpubTocEntry[] | null;
}

export const companionEbookApi = {
  getCompanionEbookState: (bookId: number) =>
    fetchApi<CompanionEbookState>(`/books/${bookId}/companion-epub/state`),

  /** Independent state/metadata reads can straddle reconciliation; bind them by response filename (#2022). */
  getCompanionEbookMetadata: (bookId: number) =>
    fetchApi<CompanionEbookMetadata>(`/books/${bookId}/companion-epub/metadata`),

  /** Strict route body: `{ index }` only. */
  putCompanionEbookSelection: (bookId: number, index: number) =>
    fetchApi<CompanionEbookState>(`/books/${bookId}/companion-epub/selection`, {
      method: 'PUT',
      body: JSON.stringify({ index }),
    }),

  /** `URL_BASE` is mandatory for download anchors in sub-path deployments. */
  getCompanionEbookDownloadUrl: (bookId: number) =>
    `${URL_BASE}/api/books/${bookId}/companion-epub`,

  /** A 202 means reconciliation was queued, not completed; callers must poll state without assuming the first refetch is new (#2034). */
  refreshCompanionEbook: (bookId: number) =>
    fetchApi<void>(`/books/${bookId}/companion-epub/refresh`, { method: 'POST' }),
};
