import { z } from 'zod';
import type {
  ConnectorAdapter,
  ConnectorImportBatch,
  ConnectorRefreshResult,
  ConnectorTarget,
  ConnectorTestResult,
} from './types.js';
import { ConnectorRequestError } from './errors.js';
import { getErrorMessage } from '@shared/error-message.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { CONNECTOR_TIMEOUT_MS } from '../utils/constants.js';

export interface PlexPathMapping {
  localPath: string;
  serverPath: string;
}

export interface PlexConnectorConfig {
  baseUrl: string;
  token: string;
  sectionId: string;
  pathMappings?: PlexPathMapping[];
  // Opt into one section-wide request when any item has no derivable path. Off by
  // default because a full-library scan is dangerous at scale.
  fallbackToFullRefresh?: boolean;
}

// Plex defaults to XML; request and validate JSON.
const plexSectionsResponseSchema = z.object({
  MediaContainer: z.object({
    Directory: z.array(z.object({
      key: z.string(),
      title: z.string().nullish(),
    }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();

function classifyStatus(status: number, notFoundField: string | null): ConnectorRequestError {
  if (status === 401 || status === 403) {
    return new ConnectorRequestError(`Authentication failed (HTTP ${status})`, {
      retryable: false,
      fieldErrors: { token: 'Invalid Plex token' },
    });
  }
  if (status === 404 && notFoundField) {
    return new ConnectorRequestError(`Section or path not found (HTTP ${status})`, {
      retryable: false,
      fieldErrors: { [notFoundField]: 'Library section not found' },
    });
  }
  if (status >= 500) {
    return new ConnectorRequestError(`Server error (HTTP ${status})`, { retryable: true });
  }
  return new ConnectorRequestError(`Request failed (HTTP ${status})`, { retryable: false });
}

function connectionError(error: unknown): ConnectorRequestError {
  return new ConnectorRequestError(`Connection failed: ${getErrorMessage(error)}`, {
    retryable: true,
    fieldErrors: { baseUrl: 'Could not connect to server' },
  });
}

/** Normalize a path prefix: forward slashes, exactly one trailing slash. */
function normalizePrefix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

// mapped includes identity rewrites; passthrough means no mapping matched; skip means
// no derivable path. Use the kind for accounting—output === input can still be mapped.
export type ResolvedPathKind = 'mapped' | 'passthrough' | 'skip';

export interface ResolvedServerPath {
  kind: ResolvedPathKind;
  path: string;
}

// Longest-prefix mapping from narratorr to Plex, the opposite direction from
// download-client remote-path mapping.
export function classifyServerPath(libraryPath: string, mappings: PlexPathMapping[]): ResolvedServerPath {
  if (!libraryPath || !libraryPath.trim()) return { kind: 'skip', path: '' };
  const normalizedPath = libraryPath.replace(/\\/g, '/');

  let bestMatch: PlexPathMapping | null = null;
  let bestLength = 0;
  for (const mapping of mappings) {
    const normalizedLocal = normalizePrefix(mapping.localPath);
    if (normalizedPath.startsWith(normalizedLocal) || (normalizedPath + '/').startsWith(normalizedLocal)) {
      if (normalizedLocal.length > bestLength) {
        bestMatch = mapping;
        bestLength = normalizedLocal.length;
      }
    }
  }

  if (!bestMatch) return { kind: 'passthrough', path: normalizedPath };
  if (!bestMatch.serverPath || !bestMatch.serverPath.trim()) return { kind: 'skip', path: '' };

  const normalizedLocal = normalizePrefix(bestMatch.localPath);
  const normalizedServer = normalizePrefix(bestMatch.serverPath);
  const remainder = normalizedPath.slice(normalizedLocal.length - 1); // keep the leading /
  return { kind: 'mapped', path: normalizedServer.slice(0, -1) + remainder }; // drop server trailing /, append remainder
}

export function resolveServerPath(libraryPath: string, mappings: PlexPathMapping[]): string {
  return classifyServerPath(libraryPath, mappings).path;
}

export class PlexConnector implements ConnectorAdapter {
  readonly type = 'plex' as const;

  private baseUrl: string;
  private token: string;
  private sectionId: string;
  private pathMappings: PlexPathMapping[];
  private fallbackToFullRefresh: boolean;

  constructor(config: PlexConnectorConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.sectionId = config.sectionId;
    this.pathMappings = config.pathMappings ?? [];
    this.fallbackToFullRefresh = config.fallbackToFullRefresh ?? false;
  }

  // Plex uses X-Plex-Token rather than Bearer authentication.
  private get authHeaders(): Record<string, string> {
    return { 'X-Plex-Token': this.token, Accept: 'application/json' };
  }

  async listTargets(): Promise<ConnectorTarget[]> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/library/sections`, { headers: this.authHeaders }, CONNECTOR_TIMEOUT_MS);
    } catch (error: unknown) {
      throw connectionError(error);
    }
    if (!res.ok) throw classifyStatus(res.status, null);

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (error: unknown) {
      throw new ConnectorRequestError(`Plex returned a non-JSON /library/sections response: ${getErrorMessage(error)}`, { retryable: false });
    }
    const parsed = plexSectionsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConnectorRequestError('Plex returned an unexpected /library/sections response', { retryable: false });
    }
    return (parsed.data.MediaContainer.Directory ?? []).map((d) => ({ id: d.key, name: d.title ?? d.key }));
  }

  async test(): Promise<ConnectorTestResult> {
    try {
      await this.checkIdentity();
      const targets = await this.listTargets();
      const found = targets.some((t) => t.id === this.sectionId);
      if (!found) {
        return {
          success: false,
          message: `Section "${this.sectionId}" not found. Available: ${targets.map((t) => t.name).join(', ') || 'none'}`,
          fieldErrors: { sectionId: 'Configured section not found on server' },
        };
      }
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof ConnectorRequestError) {
        return {
          success: false,
          message: error.message,
          ...(error.fieldErrors && { fieldErrors: error.fieldErrors }),
        };
      }
      return { success: false, message: getErrorMessage(error) };
    }
  }

  private async checkIdentity(): Promise<void> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/identity`, { headers: this.authHeaders }, CONNECTOR_TIMEOUT_MS);
    } catch (error: unknown) {
      throw connectionError(error);
    }
    if (!res.ok) throw classifyStatus(res.status, null);
  }

  // Issue one targeted request per distinct derivable path. Fail fast; the service
  // retries the idempotent batch. No-path skips remain a successful structured result.
  async refreshImport(batch: ConnectorImportBatch, signal: AbortSignal): Promise<ConnectorRefreshResult> {
    const { distinctPaths, skipped, passthrough, resolvedServerPaths } = this.planRequests(batch);

    for (const serverPath of distinctPaths) {
      await this.issueRefresh(this.targetedRefreshUrl(serverPath), signal);
    }

    const refreshed = distinctPaths.length;
    const passthroughNote = passthrough > 0 ? ` (${passthrough} passthrough — no mapping matched)` : '';

    if (skipped > 0 && this.fallbackToFullRefresh) {
      // Full refresh converts skips to fallbackRefreshed so the service does not warn.
      await this.issueRefresh(this.sectionRefreshUrl(), signal);
      return {
        success: true,
        message: `refreshed ${refreshed} paths${passthroughNote}, ${skipped} no-derivable-path items via full section refresh`,
        skipped: 0,
        passthrough,
        fallbackRefreshed: skipped,
        resolvedServerPaths,
      };
    }

    const skippedNote = skipped > 0 ? `, skipped ${skipped} items` : '';
    return {
      success: true,
      message: `refreshed ${refreshed} paths${passthroughNote}${skippedNote}`,
      skipped,
      passthrough,
      resolvedServerPaths,
    };
  }

  // The service scales its timeout from this exact request plan.
  estimateRequestCount(batch: ConnectorImportBatch): number {
    const { distinctPaths, skipped } = this.planRequests(batch);
    return distinctPaths.length + (skipped > 0 && this.fallbackToFullRefresh ? 1 : 0);
  }

  // Single source for both execution and estimates. Count passthrough from kind, not
  // output equality, because identity mappings are mapped.
  private planRequests(batch: ConnectorImportBatch): { distinctPaths: string[]; skipped: number; passthrough: number; resolvedServerPaths: string[] } {
    const distinctPaths = new Set<string>();
    let skipped = 0;
    let passthrough = 0;
    for (const item of batch.items) {
      const resolved = classifyServerPath(item.libraryPath, this.pathMappings);
      if (resolved.kind === 'skip') {
        skipped++;
        continue;
      }
      if (resolved.kind === 'passthrough') passthrough++;
      distinctPaths.add(resolved.path);
    }
    const paths = [...distinctPaths];
    return { distinctPaths: paths, skipped, passthrough, resolvedServerPaths: paths };
  }

  private targetedRefreshUrl(serverPath: string): string {
    return `${this.baseUrl}/library/sections/${encodeURIComponent(this.sectionId)}/refresh?path=${encodeURIComponent(serverPath)}`;
  }

  private sectionRefreshUrl(): string {
    return `${this.baseUrl}/library/sections/${encodeURIComponent(this.sectionId)}/refresh`;
  }

  private async issueRefresh(url: string, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: this.authHeaders }, CONNECTOR_TIMEOUT_MS, signal);
    } catch (error: unknown) {
      throw connectionError(error);
    }
    if (!res.ok) throw classifyStatus(res.status, 'sectionId');
  }
}
