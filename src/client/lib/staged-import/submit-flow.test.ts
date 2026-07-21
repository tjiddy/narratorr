import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { SUBMISSION_ERROR_CODES, type StagedImportItem } from '../../../core/import-staging/schemas.js';
import { runSubmit, SubmitError, type SubmitDisposition } from './submit-flow.js';

const noSleep = { sleep: () => Promise.resolve(), random: () => 0 };
const items: StagedImportItem[] = [{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }];

function makeApi(overrides: Partial<Record<'createSubmission' | 'putSubmissionItems' | 'finalizeSubmission', unknown>> = {}) {
  return {
    createSubmission: vi.fn(() => Promise.resolve({ id: 10 } as never)),
    putSubmissionItems: vi.fn(() => Promise.resolve({ id: 10 } as never)),
    finalizeSubmission: vi.fn(() => Promise.resolve({ id: 10 } as never)),
    ...overrides,
  } as never;
}

async function expectDisposition(promise: Promise<unknown>, disposition: SubmitDisposition) {
  await expect(promise).rejects.toMatchObject({ disposition });
}

describe('runSubmit — happy path', () => {
  it('creates, PUTs, finalizes and returns the durable id, reporting progress', async () => {
    const api = makeApi();
    const onChunkProgress = vi.fn();
    const result = await runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep, onChunkProgress });
    expect(result).toEqual({ submissionId: 10 });
    expect(api.createSubmission).toHaveBeenCalledOnce();
    expect(api.putSubmissionItems).toHaveBeenCalled();
    expect(api.finalizeSubmission).toHaveBeenCalledOnce();
    expect(onChunkProgress).toHaveBeenCalled();
  });

  it('threads manual mode into the create body', async () => {
    const api = makeApi();
    await runSubmit({ api, source: 'manual', mode: 'copy', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep });
    expect(api.createSubmission).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual', mode: 'copy', expectedCount: 2 }));
  });
});

describe('runSubmit — create failures', () => {
  it('maps a 409 digest-conflict and does NOT PUT', async () => {
    const api = makeApi({ createSubmission: vi.fn(() => Promise.reject(new ApiError(409, { error: SUBMISSION_ERROR_CODES.digestConflict }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'digest-conflict');
    expect(api.putSubmissionItems).not.toHaveBeenCalled();
  });

  it('maps a non-retryable invalid-body 4xx to create-invalid', async () => {
    const api = makeApi({ createSubmission: vi.fn(() => Promise.reject(new ApiError(400, { error: 'invalid-body' }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'create-invalid');
  });

  it('maps transport exhaustion to create-unreachable', async () => {
    const api = makeApi({ createSubmission: vi.fn(() => Promise.reject(new Error('network'))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'create-unreachable');
    expect(api.createSubmission).toHaveBeenCalledTimes(5);
  });
});

describe('runSubmit — PUT failures', () => {
  it.each([413, 400, 409])('maps a permanent %d to put-failed and does NOT finalize', async (status) => {
    const api = makeApi({ putSubmissionItems: vi.fn(() => Promise.reject(new ApiError(status, { error: 'x' }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'put-failed');
    expect(api.finalizeSubmission).not.toHaveBeenCalled();
  });
});

describe('runSubmit — finalize failures', () => {
  it('maps 409 gaps/digest-mismatch to finalize-failed', async () => {
    const api = makeApi({ finalizeSubmission: vi.fn(() => Promise.reject(new ApiError(409, { error: SUBMISSION_ERROR_CODES.finalizeGaps }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'finalize-failed');
  });

  it('maps 422 item-invalid to finalize-invariant', async () => {
    const api = makeApi({ finalizeSubmission: vi.fn(() => Promise.reject(new ApiError(422, { error: SUBMISSION_ERROR_CODES.itemInvalid }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'finalize-invariant');
  });

  it('maps 404 to finalize-missing', async () => {
    const api = makeApi({ finalizeSubmission: vi.fn(() => Promise.reject(new ApiError(404, { error: 'not-found' }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'finalize-missing');
  });

  it('maps 5xx exhaustion to finalize-unreachable', async () => {
    const api = makeApi({ finalizeSubmission: vi.fn(() => Promise.reject(new ApiError(503, { error: 'x' }))) });
    await expectDisposition(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep }), 'finalize-unreachable');
    expect(api.finalizeSubmission).toHaveBeenCalledTimes(5);
  });
});

describe('runSubmit — abort', () => {
  it('maps an aborted signal to the aborted disposition', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = makeApi();
    await expect(runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep, signal: controller.signal }))
      .rejects.toBeInstanceOf(SubmitError);
    await expectDisposition(
      runSubmit({ api, source: 'library', items, clientSubmissionId: 'u', payloadDigest: 'd', retry: noSleep, signal: controller.signal }),
      'aborted',
    );
  });
});
