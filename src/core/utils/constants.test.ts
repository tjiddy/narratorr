import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  INDEXER_TIMEOUT_MS,
  PROXY_TIMEOUT_MS,
  NOTIFIER_TIMEOUT_MS,
  IMPORT_LIST_TIMEOUT_MS,
  AUDIBLE_TIMEOUT_MS,
  AUDNEXUS_TIMEOUT_MS,
  HTTP_DOWNLOAD_TIMEOUT_MS,
} from './constants.js';

describe('timeout constants', () => {
  it('INDEXER_TIMEOUT_MS is 30_000 (30s)', () => {
    expect(INDEXER_TIMEOUT_MS).toBe(30_000);
  });

  it('PROXY_TIMEOUT_MS is 60_000 (60s)', () => {
    expect(PROXY_TIMEOUT_MS).toBe(60_000);
  });

  it('DEFAULT_REQUEST_TIMEOUT_MS is 15_000 (15s)', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('NOTIFIER_TIMEOUT_MS is 10_000 (10s)', () => {
    expect(NOTIFIER_TIMEOUT_MS).toBe(10_000);
  });

  it('IMPORT_LIST_TIMEOUT_MS is 30_000 (30s)', () => {
    expect(IMPORT_LIST_TIMEOUT_MS).toBe(30_000);
  });

  it('AUDIBLE_TIMEOUT_MS is 10_000 (10s)', () => {
    expect(AUDIBLE_TIMEOUT_MS).toBe(10_000);
  });

  it('AUDNEXUS_TIMEOUT_MS is 15_000 (15s)', () => {
    expect(AUDNEXUS_TIMEOUT_MS).toBe(15_000);
  });

  it('HTTP_DOWNLOAD_TIMEOUT_MS is 30_000 (30s)', () => {
    expect(HTTP_DOWNLOAD_TIMEOUT_MS).toBe(30_000);
  });
});
