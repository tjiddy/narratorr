import { ApiError, type Api, type ImportMode } from '@/lib/api';
import { SUBMISSION_ERROR_CODES, type StagedImportItem, type SubmissionSource } from '../../../core/import-staging/schemas.js';
import { packStagedChunks } from '@/lib/confirm-chunks.js';
import { runWithRetry, isRetryableError, withSignal, type RetryOptions } from './retry.js';

/**
 * The staged submit pipeline (#1902, F9/F10/F11): create → inert chunked PUT →
 * digest-verified finalize, each call wrapped in the shared retry policy. Every
 * failure resolves to a typed {@link SubmitDisposition} that fixes the banner copy,
 * whether the outbox hint is retained or evicted, and whether a by-client recovery
 * probe should follow — the caller (hook) maps the disposition onto UI + outbox.
 */

export type SubmitDisposition =
  | 'aborted' // unmount/navigation — surface nothing
  | 'create-unreachable' // create exhaustion / lost response — banner, hint retained, probe by-client next mount
  | 'digest-conflict' // create 409 — a durable header with this id + a DIFFERENT digest exists; fresh UUID on retry
  | 'create-invalid' // create non-retryable 4xx (invalid body) — surface error, evict hint
  | 'put-failed' // PUT permanent/exhausted — stop upload, no finalize, rows stay selected, hint left for receiving reconcile
  | 'finalize-failed' // finalize 409 gaps/digest-mismatch — error + evict
  | 'finalize-invariant' // finalize 422 item-invalid — invariant copy + evict, no nudge
  | 'finalize-missing' // finalize 404 — never landed, evict + safe re-run
  | 'finalize-unreachable'; // finalize 5xx exhaustion — retry then by-client recovery, hint retained

export class SubmitError extends Error {
  constructor(public readonly disposition: SubmitDisposition, public readonly cause?: unknown) {
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

type StagedApi = Pick<Api, 'createSubmission' | 'putSubmissionItems' | 'finalizeSubmission'>;

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
  /** Fired once the durable `receiving` header lands (F8) — lets the caller refresh the #1894 reads. */
  onCreated?: (submissionId: number) => void;
}

async function createStep(params: SubmitParams): Promise<number> {
  const { api, source, mode, items, clientSubmissionId, payloadDigest, retry, signal } = params;
  const body =
    source === 'manual'
      ? ({ source, mode: mode!, clientSubmissionId, payloadDigest, expectedCount: items.length } as const)
      : ({ source, clientSubmissionId, payloadDigest, expectedCount: items.length } as const);
  try {
    return (await runWithRetry(() => api.createSubmission(body), withSignal(retry, signal))).id;
  } catch (error) {
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
      await runWithRetry(() => api.putSubmissionItems(submissionId, { items: chunk }), withSignal(retry, signal));
    } catch (error) {
      if (isAbort(error, signal)) throw new SubmitError('aborted', error);
      // Permanent (400/409/413) or exhausted transport → stop; the receiving header is inert.
      throw new SubmitError('put-failed', error);
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
    return new SubmitError('finalize-failed', error); // 409 gaps / digest-mismatch / other 4xx
  }
  return new SubmitError('finalize-unreachable', error); // 5xx exhaustion → by-client recovery
}

/** Runs create → PUT → finalize. Resolves the durable submission id, or throws a {@link SubmitError}. */
export async function runSubmit(params: SubmitParams): Promise<{ submissionId: number }> {
  const { api, retry, signal } = params;
  const submissionId = await createStep(params);
  params.onCreated?.(submissionId);
  await putStep(params, submissionId);
  try {
    await runWithRetry(() => api.finalizeSubmission(submissionId), withSignal(retry, signal));
  } catch (error) {
    throw mapFinalizeError(error, signal);
  }
  return { submissionId };
}
