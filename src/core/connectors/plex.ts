import { z } from 'zod';
import type {
  ConnectorAdapter,
  ConnectorImportBatch,
  ConnectorRefreshResult,
  ConnectorTarget,
  ConnectorTestResult,
} from './types.js';
import { ConnectorRequestError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { CONNECTOR_TIMEOUT_MS } from '../utils/constants.js';

export interface PlexPathMapping {
  /** narratorr-side library/local path prefix. */
  localPath: string;
  /** Plex-server-side path prefix the local prefix rewrites to. */
  serverPath: string;
}

export interface PlexConnectorConfig {
  baseUrl: string;
  token: string;
  sectionId: string;
  pathMappings?: PlexPathMapping[];
  /**
   * When a batch item resolves to NO derivable server path (empty/whitespace),
   * fall back to a single section-wide refresh. Default OFF — a no-derivable item
   * is skipped, never silently collapsed to a section scan (the "works on my tiny
   * library" trap at scale).
   */
  fallbackToFullRefresh?: boolean;
}

// Plex returns XML by default; we request JSON via `Accept: application/json`.
// /library/sections shape: { MediaContainer: { Directory: [{ key, title }] } }.
const plexSectionsResponseSchema = z.object({
  MediaContainer: z.object({
    Directory: z.array(z.object({
      key: z.string(),
      title: z.string(),
    }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();

/** Map a non-ok HTTP status to a typed connector error with the right retry/field classification. */
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

/** Wrap a transport/DNS/timeout/abort failure as a retryable connection error scoped to baseUrl. */
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

/**
 * Resolve a narratorr `libraryPath` to a Plex server path via longest-prefix
 * path mapping. Returns the resolved server path, or an empty string for the
 * **no-derivable-path** case (caller treats empty as skip/fallback):
 *  - `libraryPath` is itself empty/whitespace, or
 *  - a mapping matched but its `serverPath` rewrite is empty/whitespace.
 * No mapping match → PASSTHROUGH: the (non-empty) `libraryPath` unchanged.
 *
 * Connector-scoped (narratorr local → Plex server) and intentionally separate
 * from the download-client remote-path mapping, which maps the other direction.
 */
export function resolveServerPath(libraryPath: string, mappings: PlexPathMapping[]): string {
  if (!libraryPath || !libraryPath.trim()) return '';
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

  if (!bestMatch) return normalizedPath; // passthrough (non-empty)
  if (!bestMatch.serverPath || !bestMatch.serverPath.trim()) return ''; // no-derivable-path

  const normalizedLocal = normalizePrefix(bestMatch.localPath);
  const normalizedServer = normalizePrefix(bestMatch.serverPath);
  const remainder = normalizedPath.slice(normalizedLocal.length - 1); // keep the leading /
  return normalizedServer.slice(0, -1) + remainder; // drop server trailing /, append remainder
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

  // X-Plex-Token (NOT Authorization: Bearer); request JSON so responses parse.
  private get authHeaders(): Record<string, string> {
    return { 'X-Plex-Token': this.token, Accept: 'application/json' };
  }

  /** GET /library/sections → ConnectorTarget[]; throws ConnectorRequestError on failure. */
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
    return (parsed.data.MediaContainer.Directory ?? []).map((d) => ({ id: d.key, name: d.title }));
  }

  /** Diagnostic test — never throws for expected failures; folds them into a field-scoped result. */
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

  /** GET /identity — auth + reachability probe. Throws ConnectorRequestError on failure. */
  private async checkIdentity(): Promise<void> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/identity`, { headers: this.authHeaders }, CONNECTOR_TIMEOUT_MS);
    } catch (error: unknown) {
      throw connectionError(error);
    }
    if (!res.ok) throw classifyStatus(res.status, null);
  }

  /**
   * Targeted, path-scoped refresh. Resolves each item to a Plex server path,
   * dedupes distinct derivable paths, and issues ONE targeted refresh per
   * distinct path (`…/sections/{id}/refresh?path=`). Fail-fast: throws on the
   * first non-2xx/transport failure, abandoning the rest — the framework retries
   * the whole (idempotent) batch once for retryable errors. Returns
   * { success: true, message } only when ALL derivable paths succeed; skipped
   * no-derivable-path items ride the success message (never success:false/throw).
   */
  async refreshImport(batch: ConnectorImportBatch, signal: AbortSignal): Promise<ConnectorRefreshResult> {
    const { distinctPaths, skipped } = this.planRequests(batch);

    for (const serverPath of distinctPaths) {
      await this.issueRefresh(this.targetedRefreshUrl(serverPath), signal);
    }

    if (skipped > 0 && this.fallbackToFullRefresh) {
      await this.issueRefresh(this.sectionRefreshUrl(), signal);
      return { success: true, message: `refreshed ${distinctPaths.length} paths, ${skipped} no-derivable-path items via full section refresh` };
    }

    const message = skipped > 0
      ? `refreshed ${distinctPaths.length} paths, skipped ${skipped} items`
      : `refreshed ${distinctPaths.length} paths`;
    return { success: true, message };
  }

  /**
   * One request per distinct derivable server path, plus one more when skipped
   * (no-derivable-path) items trigger the section-wide fallback. Mirrors
   * planRequests / refreshImport exactly so the service's scaled flush-timeout
   * budget matches the work this batch will actually do. Pure: no I/O.
   */
  estimateRequestCount(batch: ConnectorImportBatch): number {
    const { distinctPaths, skipped } = this.planRequests(batch);
    return distinctPaths.length + (skipped > 0 && this.fallbackToFullRefresh ? 1 : 0);
  }

  /**
   * Resolve a batch to its request plan: the distinct derivable Plex server paths
   * (each becomes one targeted refresh) and the count of no-derivable-path items
   * (skipped, or collapsed to a single section-wide refresh when the fallback is on).
   */
  private planRequests(batch: ConnectorImportBatch): { distinctPaths: string[]; skipped: number } {
    const distinctPaths = new Set<string>();
    let skipped = 0;
    for (const item of batch.items) {
      const serverPath = resolveServerPath(item.libraryPath, this.pathMappings);
      if (!serverPath || !serverPath.trim()) {
        skipped++;
        continue;
      }
      distinctPaths.add(serverPath);
    }
    return { distinctPaths: [...distinctPaths], skipped };
  }

  private targetedRefreshUrl(serverPath: string): string {
    return `${this.baseUrl}/library/sections/${encodeURIComponent(this.sectionId)}/refresh?path=${encodeURIComponent(serverPath)}`;
  }

  private sectionRefreshUrl(): string {
    return `${this.baseUrl}/library/sections/${encodeURIComponent(this.sectionId)}/refresh`;
  }

  /** Issue one refresh GET, classifying any non-2xx/transport failure as a thrown ConnectorRequestError. */
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
