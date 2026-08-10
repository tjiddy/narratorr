import { execFile } from 'node:child_process';
// Direct import keeps Node-only code out of the core/utils barrel consumed by Vite.
import { sanitizedEnv } from '@core/utils/sanitized-env.js';
import { MUTAGEN_PROGRAM, MUTAGEN_COVER_VERIFY_KEY } from '@core/utils/mutagen-program.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { MutagenRequest } from './mutagen-tag-payload.js';

export interface MutagenWriteResult {
  ok: boolean;
  reason?: string;
  sizeBefore?: number;
  sizeAfter?: number;
}

interface MutagenResponse {
  ok?: unknown;
  error?: unknown;
  sizeBefore?: unknown;
  sizeAfter?: unknown;
  verified?: unknown;
}

/** The helper echoes every written value back; a >64 KB description travels twice. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
/** A wedged interpreter would hold the per-file write lock, so the child is bounded. */
const WRITE_TIMEOUT_MS = 300_000;

function runProgram(
  pythonPath: string,
  request: MutagenRequest,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      pythonPath,
      ['-c', MUTAGEN_PROGRAM],
      {
        env: sanitizedEnv({ PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }),
        maxBuffer: MAX_STDOUT_BYTES,
        timeout: WRITE_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    // The tag payload goes on stdin, never on argv: argv is visible in `ps` and a description is
    // unbounded (#2210 D1/AC16).
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(request), 'utf8');
  });
}

/**
 * Success is exactly: exit 0, `ok: true`, and a `verified` map carrying every requested key with
 * its exact requested value. File size is reported, never adjudicated — an `overwrite` that
 * legitimately shrinks the file (shorter description, smaller replacement cover) is a success, and
 * a size increase never rescues a failed verification (#2210 D2/AC12).
 */
export function verifyRequestedKeys(
  request: MutagenRequest,
  verified: Record<string, string>,
): string | null {
  const missing: string[] = [];
  for (const op of request.ops) {
    if (verified[op.key] !== op.value) missing.push(op.key);
  }
  // A cover has no requested value to compare — the helper reports the stored byte length instead.
  if (request.cover) {
    const storedBytes = verified[MUTAGEN_COVER_VERIFY_KEY];
    if (!storedBytes || storedBytes === '0') missing.push('cover art');
  }
  return missing.length > 0 ? `Tag verification failed for: ${missing.join(', ')}` : null;
}

export async function writeTagsWithMutagen(
  pythonPath: string,
  request: MutagenRequest,
): Promise<MutagenWriteResult> {
  let stdout: string;
  try {
    ({ stdout } = await runProgram(pythonPath, request));
  } catch (error: unknown) {
    return { ok: false, reason: getErrorMessage(error) };
  }

  let response: MutagenResponse;
  try {
    response = JSON.parse(stdout) as MutagenResponse;
  } catch {
    return { ok: false, reason: `Tag writer returned unparseable output: ${stdout.slice(0, 200)}` };
  }

  const sizes = {
    ...(typeof response.sizeBefore === 'number' && { sizeBefore: response.sizeBefore }),
    ...(typeof response.sizeAfter === 'number' && { sizeAfter: response.sizeAfter }),
  };

  if (response.ok !== true) {
    const reason = typeof response.error === 'string' ? response.error : 'Tag writer reported failure';
    return { ok: false, reason, ...sizes };
  }

  const verified = (response.verified ?? {}) as Record<string, string>;
  const failure = verifyRequestedKeys(request, verified);
  if (failure) return { ok: false, reason: failure, ...sizes };

  return { ok: true, ...sizes };
}
