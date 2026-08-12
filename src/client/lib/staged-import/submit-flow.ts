import { ApiError, type Api, type ImportMode } from '@/lib/api';
import { SUBMISSION_ERROR_CODES, type StagedImportItem, type SubmissionSource } from '@core/import-staging/schemas.js';
import { packStagedChunks } from '@/lib/confirm-chunks.js';
import { runWithRetry, isRetryableError, withSignal, type RetryOptions } from './retry.js';

// Create → inert chunked PUT → digest-verified finalize under the shared retry policy.
// SubmitError dispositions select the hook's UI and outbox recovery policy.

export type SubmitDisposition =
  | 'aborted' // Surface nothing.
  | 'create-unreachable' // Retain hint; recover by client ID.
  | 'digest-conflict' // Existing ID has another digest; retry with a fresh UUID.
  | 'create-invalid' // Permanent create failure; evict hint.
  | 'put-failed' // Stop upload and retain receiving hint.
  | 'finalize-failed' // Finalize mismatch; evict hint.
  | 'finalize-invariant' // Persisted-item invariant; evict hint.
  | 'finalize-missing' // Never landed; evict and allow retry.
  | 'finalize-unreachable'; // Recover by client ID and retain hint.

export class SubmitError extends Error {
  constructor(
    public readonly disposition: SubmitDisposition,
    public readonly cause?: unknown,
    /** Confirmed upload count for put-failed copy. */
    public readonly counts?: { received: number; total: number },
  ) {
    super(disposition);
    this.name = 'SubmitError';
  }
}

/** The server error body is `{ error: <code>, message }`; pull the named code. */
function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.body as { error?: string } | undefined)?.error : undefined;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

type StagedApi = Pick<Api, 'createImportSubmission' | 'putImportSubmissionItems' | 'finalizeImportSubmission'>;

export interface SubmitParams {
  api: StagedApi;
  source: SubmissionSource;
  mode?: ImportMode;
  /** The frozen, normalized survivor array — ordinal = index. */
  items: readonly StagedImportItem[];
  clientSubmissionId: string;
  payloadDigest: string;
  retry?: RetryOptions;
  signal?: AbortSignal;
  /** Progress across the sequential PUT run — drives "Registering X of Y…". */
  onChunkProgress?: (progress: { current: number; total: number; chunks: number }) => void;
  /** Fired once the durable receiving header lands. */
  onCreated?: (submissionId: number) => void;
}

async function createStep(params: SubmitParams): Promise<number> {
  const { api, source, mode, items, clientSubmissionId, payloadDigest, retry, signal } = params;
  const body =
    source === 'manual'
      ? ({ source, mode: mode!, clientSubmissionId, payloadDigest, expectedCount: items.length } as const)
      : ({ source, clientSubmissionId, payloadDigest, expectedCount: items.length } as const);
  try {
    return (await runWithRetry(() => api.createImportSubmission(body), withSignal(retry, signal))).id;
  } catch (error: unknown) {
    if (isAbort(error, signal)) throw new SubmitError('aborted', error);
    if (error instanceof ApiError && error.status === 409 && errorCode(error) === SUBMISSION_ERROR_CODES.digestConflict) {
      throw new SubmitError('digest-conflict', error);
    }
    if (error instanceof ApiError && !isRetryableError(error)) throw new SubmitError('create-invalid', error);
    throw new SubmitError('create-unreachable', error);
  }
}

async function putStep(params: SubmitParams, submissionId: number): Promise<void> {
  const { api, items, retry, signal, onChunkProgress } = params;
  const rows = items.map((item, ordinal) => ({ ordinal, item }));
  const chunks = packStagedChunks(rows);
  let sent = 0;
  for (const chunk of chunks) {
    onChunkProgress?.({ current: sent + chunk.length, total: rows.length, chunks: chunks.length });
    try {
      await runWithRetry(() => api.putImportSubmissionItems(submissionId, { items: chunk }), withSignal(retry, signal));
    } catch (error: unknown) {
      if (isAbort(error, signal)) throw new SubmitError('aborted', error);
      // Count only confirmed chunks because the failed in-flight chunk's fate is unknown.
      throw new SubmitError('put-failed', error, { received: sent, total: rows.length });
    }
    sent += chunk.length;
  }
  onChunkProgress?.({ current: sent, total: rows.length, chunks: chunks.length });
}

function mapFinalizeError(error: unknown, signal?: AbortSignal): SubmitError {
  if (isAbort(error, signal)) return new SubmitError('aborted', error);
  if (error instanceof ApiError && !isRetryableError(error)) {
    const code = errorCode(error);
    if (error.status === 422 || code === SUBMISSION_ERROR_CODES.itemInvalid) return new SubmitError('finalize-invariant', error);
    if (error.status === 404) return new SubmitError('finalize-missing', error);
    return new SubmitError('finalize-failed', error);
  }
  return new SubmitError('finalize-unreachable', error);
}

export async function runSubmit(params: SubmitParams): Promise<{ submissionId: number }> {
  const { api, retry, signal } = params;
  const submissionId = await createStep(params);
  params.onCreated?.(submissionId);
  await putStep(params, submissionId);
  try {
    await runWithRetry(() => api.finalizeImportSubmission(submissionId), withSignal(retry, signal));
  } catch (error: unknown) {
    throw mapFinalizeError(error, signal);
  }
  return { submissionId };
}
