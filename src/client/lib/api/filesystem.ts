import { fetchApi } from './client.js';

export interface BrowseResult {
  dirs: string[];
  parent: string | null;
  /** Present only when the browse opted in to audio listing (#2435 AC20). */
  files?: string[];
}

/** The opt-in capability. `legacy` sends no parameter and receives today's `{ dirs, parent }`. */
export type BrowseCapability = 'legacy' | 'audio';

export const filesystemApi = {
  browseDirectory: (path: string, capability: BrowseCapability = 'legacy') =>
    fetchApi<BrowseResult>(
      `/filesystem/browse?path=${encodeURIComponent(path)}${capability === 'audio' ? '&include=audio' : ''}`,
    ),
};
