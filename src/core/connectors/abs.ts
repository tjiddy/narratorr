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

export interface AudiobookshelfConnectorConfig {
  baseUrl: string;
  apiKey: string;
  libraryId: string;
}

const absLibrariesResponseSchema = z.object({
  libraries: z.array(z.object({
    id: z.string(),
    name: z.string(),
  }).passthrough()),
}).passthrough();

function classifyStatus(status: number, notFoundField: string | null): ConnectorRequestError {
  if (status === 401 || status === 403) {
    return new ConnectorRequestError(`Authentication failed (HTTP ${status})`, {
      retryable: false,
      fieldErrors: { apiKey: 'Invalid API key' },
    });
  }
  if (status === 404 && notFoundField) {
    return new ConnectorRequestError(`Library not found (HTTP ${status})`, {
      retryable: false,
      fieldErrors: { [notFoundField]: 'Library not found' },
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

export class AudiobookshelfConnector implements ConnectorAdapter {
  readonly type = 'audiobookshelf' as const;

  private baseUrl: string;
  private apiKey: string;
  private libraryId: string;

  constructor(config: AudiobookshelfConnectorConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.libraryId = config.libraryId;
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async listTargets(): Promise<ConnectorTarget[]> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/api/libraries`, { headers: this.authHeaders }, CONNECTOR_TIMEOUT_MS);
    } catch (error: unknown) {
      throw connectionError(error);
    }
    if (!res.ok) throw classifyStatus(res.status, null);

    const raw: unknown = await res.json();
    const parsed = absLibrariesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConnectorRequestError('Audiobookshelf returned an unexpected /api/libraries response', { retryable: false });
    }
    return parsed.data.libraries.map((lib) => ({ id: lib.id, name: lib.name }));
  }

  async test(): Promise<ConnectorTestResult> {
    try {
      const targets = await this.listTargets();
      const found = targets.some((t) => t.id === this.libraryId);
      if (!found) {
        return {
          success: false,
          message: `Library ID "${this.libraryId}" not found. Available: ${targets.map((t) => t.name).join(', ') || 'none'}`,
          fieldErrors: { libraryId: 'Configured library not found on server' },
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

  // ABS ignores item paths and issues one full-library scan. Forward the service
  // signal so its outer timeout cancels the request.
  async refreshImport(_batch: ConnectorImportBatch, signal: AbortSignal): Promise<ConnectorRefreshResult> {
    const url = `${this.baseUrl}/api/libraries/${encodeURIComponent(this.libraryId)}/scan`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
        body: '{}',
      }, CONNECTOR_TIMEOUT_MS, signal);
    } catch (error: unknown) {
      throw connectionError(error);
    }
    if (!res.ok) throw classifyStatus(res.status, 'libraryId');
    return { success: true };
  }

  estimateRequestCount(): number {
    return 1;
  }
}
