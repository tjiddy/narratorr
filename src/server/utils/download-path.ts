import { join } from 'node:path';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import { applyPathMapping } from '../../core/utils/path-mapping.js';

/**
 * Resolve the full save path for a download by querying the download client adapter.
 * Joins savePath + name from the adapter response and applies remote path mapping.
 */
export async function resolveSavePath(
  download: { id: number; downloadClientId: number | null; externalId: string | null },
  downloadClientService: DownloadClientService,
  remotePathMappingService?: RemotePathMappingService,
): Promise<{ resolvedPath: string; originalPath: string }> {
  if (!download.downloadClientId || !download.externalId) {
    throw new Error(`Download ${download.id} missing client or external ID`);
  }

  const adapter = await downloadClientService.getAdapter(download.downloadClientId);
  if (!adapter) {
    throw new Error(`Download client ${download.downloadClientId} not found`);
  }

  const item = await adapter.getDownload(download.externalId);
  if (!item) {
    throw new Error(`Download ${download.externalId} not found in client`);
  }

  const originalPath = join(item.savePath, item.name);
  let fullPath = originalPath;

  if (remotePathMappingService && download.downloadClientId) {
    const mappings = await remotePathMappingService.getByClientId(download.downloadClientId);
    if (mappings.length > 0) {
      fullPath = applyPathMapping(fullPath, mappings);
    }
  }

  return { resolvedPath: fullPath, originalPath };
}
