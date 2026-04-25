import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { streamCopyWithProgress } from './streaming-copy.helpers.js';

describe('streamCopyWithProgress', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'copy-test-src-'));
    destDir = await mkdtemp(join(tmpdir(), 'copy-test-dest-'));
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  it('copies all files from source to target directory', async () => {
    await writeFile(join(srcDir, 'file1.mp3'), Buffer.alloc(1024, 'a'));
    await writeFile(join(srcDir, 'file2.mp3'), Buffer.alloc(512, 'b'));

    await streamCopyWithProgress(srcDir, destDir, vi.fn());

    const file1 = await readFile(join(destDir, 'file1.mp3'));
    expect(file1.length).toBe(1024);
    const file2 = await readFile(join(destDir, 'file2.mp3'));
    expect(file2.length).toBe(512);
  });

  it('preserves directory structure recursively', async () => {
    await mkdir(join(srcDir, 'subdir'), { recursive: true });
    await writeFile(join(srcDir, 'subdir', 'nested.mp3'), Buffer.alloc(256));

    await streamCopyWithProgress(srcDir, destDir, vi.fn());

    const nested = await readFile(join(destDir, 'subdir', 'nested.mp3'));
    expect(nested.length).toBe(256);
  });

  it('invokes onProgress callback with progress 0..1', async () => {
    await writeFile(join(srcDir, 'file.mp3'), Buffer.alloc(2048));
    const onProgress = vi.fn();

    await streamCopyWithProgress(srcDir, destDir, onProgress);

    expect(onProgress).toHaveBeenCalled();
    // Final call should be at or near 1.0
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
    expect(lastCall[0]).toBeCloseTo(1.0, 1);
  });

  it('reports byte_counter with current and total', async () => {
    await writeFile(join(srcDir, 'file.mp3'), Buffer.alloc(4096));
    const onProgress = vi.fn();

    await streamCopyWithProgress(srcDir, destDir, onProgress);

    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
    expect(lastCall[1]).toMatchObject({ current: 4096, total: 4096 });
  });

  it('handles empty directory (0 bytes total) without error', async () => {
    // srcDir is empty
    const onProgress = vi.fn();

    await streamCopyWithProgress(srcDir, destDir, onProgress);

    // Should not throw, progress may or may not be called
    expect(true).toBe(true);
  });

  it('fires onProgress multiple times with increasing byte counts for a large single file', async () => {
    // 256KB file — exceeds Node stream highWaterMark (64KB), so multiple chunks are emitted
    const size = 256 * 1024;
    await writeFile(join(srcDir, 'large.m4b'), Buffer.alloc(size, 'x'));
    const onProgress = vi.fn();

    await streamCopyWithProgress(srcDir, destDir, onProgress);

    // Should have been called multiple times (not just once at end)
    expect(onProgress.mock.calls.length).toBeGreaterThan(1);

    // Each call should have increasing current byte counts
    const byteCounts = onProgress.mock.calls.map((call: unknown[]) => (call[1] as { current: number }).current);
    for (let i = 1; i < byteCounts.length; i++) {
      expect(byteCounts[i]).toBeGreaterThan(byteCounts[i - 1]);
    }

    // Final call should reach the total
    expect(byteCounts[byteCounts.length - 1]).toBe(size);
  });

  it('single file copy works correctly', async () => {
    const content = Buffer.alloc(8192, 'x');
    await writeFile(join(srcDir, 'single.m4b'), content);
    const onProgress = vi.fn();

    await streamCopyWithProgress(srcDir, destDir, onProgress);

    const copied = await readFile(join(destDir, 'single.m4b'));
    expect(copied).toEqual(content);
  });
});
