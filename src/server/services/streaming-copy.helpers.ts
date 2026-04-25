/**
 * Stream-based recursive copy with progress reporting.
 * Walks the source directory, copies each file via streams, and invokes
 * onProgress with (progress: 0..1, byteCounter: { current, total }).
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

export async function streamCopyWithProgress(
  srcDir: string,
  destDir: string,
  onProgress: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<void> {
  const files: { relativePath: string; size: number }[] = [];
  await collectFiles(srcDir, '', files);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let bytesCopied = 0;

  for (const file of files) {
    const srcPath = join(srcDir, file.relativePath);
    const destPath = join(destDir, file.relativePath);
    await mkdir(join(destPath, '..'), { recursive: true });

    const tracker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesCopied += chunk.length;
        const progress = totalSize > 0 ? bytesCopied / totalSize : 1;
        onProgress(progress, { current: bytesCopied, total: totalSize });
        callback(null, chunk);
      },
    });

    await pipeline(
      createReadStream(srcPath),
      tracker,
      createWriteStream(destPath),
    );
  }
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
