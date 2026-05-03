import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { parsePhaseHistory } from './parse-phase-history.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('parsePhaseHistory', () => {
  it('returns [] for null input without logging', () => {
    const log = createMockLogger();
    const result = parsePhaseHistory(null, log, 1);
    expect(result).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns parsed entries when JSON is valid and shape matches', () => {
    const log = createMockLogger();
    const raw = JSON.stringify([
      { phase: 'queued', startedAt: 1700000000000, completedAt: 1700000005000 },
    ]);
    const result = parsePhaseHistory(raw, log, 1);
    expect(result).toEqual([
      { phase: 'queued', startedAt: 1700000000000, completedAt: 1700000005000 },
    ]);
    expect(typeof result[0]!.startedAt).toBe('number');
    expect(typeof result[0]!.completedAt).toBe('number');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and returns [] when JSON is unparseable', () => {
    const log = createMockLogger();
    const result = parsePhaseHistory('not-json', log, 42);
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 42, error: expect.any(Object) }),
      expect.stringContaining('Unparseable phaseHistory'),
    );
  });

  it('warns and returns [] when JSON is valid but shape mismatches', () => {
    const log = createMockLogger();
    const result = parsePhaseHistory('[{"foo":"bar"}]', log, 42);
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 42, error: expect.any(Object) }),
      expect.stringContaining('Malformed phaseHistory'),
    );
  });
});
