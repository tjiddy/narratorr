import { fetchApi } from './client.js';

export interface RemotePathMapping {
  id: number;
  downloadClientId: number;
  remotePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export const remotePathMappingsApi = {
  getMappings: () => fetchApi<RemotePathMapping[]>('/remote-path-mappings'),
  getMappingsByClientId: (clientId: number) =>
    fetchApi<RemotePathMapping[]>(`/remote-path-mappings?downloadClientId=${clientId}`),
  createMapping: (data: Omit<RemotePathMapping, 'id' | 'createdAt' | 'updatedAt'>) =>
    fetchApi<RemotePathMapping>('/remote-path-mappings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMapping: (id: number, data: Partial<Omit<RemotePathMapping, 'id' | 'createdAt' | 'updatedAt'>>) =>
    fetchApi<RemotePathMapping>(`/remote-path-mappings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMapping: (id: number) =>
    fetchApi<{ success: boolean }>(`/remote-path-mappings/${id}`, { method: 'DELETE' }),
};
