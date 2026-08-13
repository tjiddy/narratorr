import { fetchApi } from './client.js';

export interface ImportListExclusion {
  id: number;
  asin: string | null;
  title: string;
  authorName: string | null;
  authorSlug: string | null;
  importListId: number | null;
  /** Snapshot taken when the exclusion was recorded; survives the list's deletion. */
  importListName: string | null;
  createdAt: string;
}

export interface ImportListExclusionListParams {
  limit?: number;
  offset?: number;
}

/** No create method: exclusions are written only by deleting an import-list book. */
export const importListExclusionsApi = {
  getImportListExclusions: (params?: ImportListExclusionListParams) => {
    const searchParams = new URLSearchParams();
    if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{ data: ImportListExclusion[]; total: number }>(
      `/import-list-exclusions${qs ? `?${qs}` : ''}`,
    );
  },
  removeImportListExclusion: (id: number) =>
    fetchApi<{ success: boolean }>(`/import-list-exclusions/${id}`, { method: 'DELETE' }),
};
