import { fetchApi } from './client.js';

export interface BrowseResult {
  dirs: string[];
  parent: string | null;
}

export const filesystemApi = {
  browseDirectory: (path: string) =>
    fetchApi<BrowseResult>(`/filesystem/browse?path=${encodeURIComponent(path)}`),
};
