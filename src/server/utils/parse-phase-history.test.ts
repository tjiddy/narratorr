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
      { jobId: 42 },
      expect.stringContaining('Unparseable phaseHistory'),
    );
  });

  it('warns and returns [] when JSON is valid but shape mismatches', () => {
    const log = createMockLogger();
    const result = parsePhaseHistory('[{"foo":"bar"}]', log, 42);
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 42, issuePaths: expect.any(Array) }),
      expect.stringContaining('Malformed phaseHistory'),
    );
  });

  // JSON.parse and ZodError messages can reproduce persisted values.
  it('reproduces neither the raw column nor persisted values in either warn payload', () => {
    const log = createMockLogger();

    parsePhaseHistory('{"phase": leaked-phase-token}', log, 1);
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls[0]![0])).not.toContain('leaked-phase');
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toEqual({ jobId: 1 });

    vi.mocked(log.warn).mockClear();
    parsePhaseHistory('[{"phase":"SENSITIVE_PHASE_VALUE","startedAt":"not-a-number"}]', log, 2);
    const [payload] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(JSON.stringify(payload)).not.toContain('SENSITIVE_PHASE_VALUE');
    expect(JSON.stringify(payload)).not.toContain('not-a-number');
    // Paths are safe diagnostics; values are not.
    expect(payload.issuePaths).toEqual(expect.arrayContaining([expect.any(String)]));
  });
});
