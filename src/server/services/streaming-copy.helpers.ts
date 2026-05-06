/**
 * Stream-based recursive copy with progress reporting.
 * Walks the source directory, copies each file via streams, and invokes
 * onProgress with (progress: 0..1, byteCounter: { current, total }).
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, join } from 'node:path';

type ProgressCallback = (progress: number, byteCounter: { current: number; total: number }) => void;

export async function streamCopyWithProgress(
  srcPath: string,
  destDir: string,
  onProgress: ProgressCallback,
): Promise<void> {
  const srcStats = await stat(srcPath);

  // Single-file source: copy directly into destDir/<basename>, preserving the
  // same Transform-tracked progress contract as the directory case.
  if (srcStats.isFile()) {
    await mkdir(destDir, { recursive: true });
    const destPath = join(destDir, basename(srcPath));
    await copyFileTracked(srcPath, destPath, srcStats.size, 0, onProgress);
    return;
  }

  const files: { relativePath: string; size: number }[] = [];
  await collectFiles(srcPath, '', files);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let bytesCopied = 0;

  for (const file of files) {
    const filePath = join(srcPath, file.relativePath);
    const destPath = join(destDir, file.relativePath);
    await mkdir(join(destPath, '..'), { recursive: true });
    bytesCopied = await copyFileTracked(filePath, destPath, totalSize, bytesCopied, onProgress);
  }
}

async function copyFileTracked(
  srcPath: string,
  destPath: string,
  totalSize: number,
  startBytes: number,
  onProgress: ProgressCallback,
): Promise<number> {
  let bytesCopied = startBytes;
  const tracker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesCopied += chunk.length;
      const progress = totalSize > 0 ? bytesCopied / totalSize : 1;
      onProgress(progress, { current: bytesCopied, total: totalSize });
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(srcPath), tracker, createWriteStream(destPath));
  return bytesCopied;
}

async function collectFiles(dir: string, prefix: string, out: { relativePath: string; size: number }[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, relativePath, out);
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      out.push({ relativePath, size: info.size });
    }
  }
}
