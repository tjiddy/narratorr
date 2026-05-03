import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { copyToLibrary } from './import-steps.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

describe('copyToLibrary onProgress wiring', () => {
  let baseDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-copy-progress-'));
    srcDir = join(baseDir, 'src');
    destDir = join(baseDir, 'dest');
    await mkdir(srcDir, { recursive: true });
    // Two audio files so progress fires across file boundaries
    await writeFile(join(srcDir, '01.mp3'), Buffer.alloc(600));
    await writeFile(join(srcDir, '02.mp3'), Buffer.alloc(400));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('invokes onProgress at least once with ratio in [0, 1] and total matching source audio size', async () => {
    const sourceStats = await stat(srcDir);
    const progressCalls: Array<{ ratio: number; current: number; total: number }> = [];

    await copyToLibrary({
      sourcePath: srcDir,
      targetPath: destDir,
      sourceStats,
      log: makeLog(),
      onProgress: (ratio, byteCounter) => {
        progressCalls.push({ ratio, current: byteCounter.current, total: byteCounter.total });
      },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    for (const call of progressCalls) {
      expect(call.ratio).toBeGreaterThanOrEqual(0);
      expect(call.ratio).toBeLessThanOrEqual(1);
      expect(call.total).toBe(1000);
    }
    // Final emission should reflect full copy
    const last = progressCalls[progressCalls.length - 1];
    expect(last!.current).toBe(1000);
    expect(last!.ratio).toBe(1);
  });

  it('copy completes successfully when onProgress is omitted (no behaviour change)', async () => {
    const sourceStats = await stat(srcDir);

    await copyToLibrary({
      sourcePath: srcDir,
      targetPath: destDir,
      sourceStats,
      log: makeLog(),
    });

    const one = await stat(join(destDir, '01.mp3'));
    const two = await stat(join(destDir, '02.mp3'));
    expect(one.size).toBe(600);
    expect(two.size).toBe(400);
  });

  it('single-file source streams progress with total equal to source file size', async () => {
    // Build a single-file source
    const fileSrc = join(baseDir, 'single.mp3');
    await writeFile(fileSrc, Buffer.alloc(800));
    const fileStats = await stat(fileSrc);

    const singleDest = join(baseDir, 'single-dest');
    const progressCalls: Array<{ ratio: number; current: number; total: number }> = [];

    await copyToLibrary({
      sourcePath: fileSrc,
      targetPath: singleDest,
      sourceStats: fileStats,
      log: makeLog(),
      onProgress: (ratio, byteCounter) => {
        progressCalls.push({ ratio, current: byteCounter.current, total: byteCounter.total });
      },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]!.total).toBe(800);
    expect(progressCalls[progressCalls.length - 1]!.current).toBe(800);
  });
});
