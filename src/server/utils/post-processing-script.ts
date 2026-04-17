import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { getErrorMessage } from './error-message.js';
import { serializeError } from './serialize-error.js';


export interface PostProcessingScriptArgs {
  scriptPath: string;
  timeoutSeconds: number;
  audiobookPath: string;
  bookTitle: string;
  bookAuthor: string | null;
  fileCount: number;
  log: FastifyBaseLogger;
}

export interface PostProcessingScriptResult {
  success: boolean;
  warning?: string;
}

export async function runPostProcessingScript(args: PostProcessingScriptArgs): Promise<PostProcessingScriptResult> {
  const { scriptPath, timeoutSeconds, audiobookPath, bookTitle, bookAuthor, fileCount, log } = args;

  if (!scriptPath) {
    return { success: true };
  }

  // Check if script exists before trying to execute
  try {
    await access(scriptPath);
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    const warning = code === 'ENOENT'
      ? `Post-processing script not found: ${scriptPath}`
      : `Post-processing script inaccessible: ${scriptPath} (${code ?? getErrorMessage(error)})`;
    log.warn({ scriptPath, error: serializeError(error) }, warning);
    return { success: false, warning };
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NARRATORR_BOOK_TITLE: bookTitle,
    NARRATORR_BOOK_AUTHOR: bookAuthor ?? '',
    NARRATORR_IMPORT_PATH: audiobookPath,
    NARRATORR_IMPORT_FILE_COUNT: fileCount.toString(),
  };

  return new Promise((resolve) => {
    execFile(scriptPath, [audiobookPath], { timeout: timeoutSeconds * 1000, env }, (error, _stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          const warning = `Post-processing script timed out after ${timeoutSeconds}s: ${scriptPath}`;
          log.warn({ scriptPath, timeoutSeconds }, warning);
          resolve({ success: false, warning });
        } else {
          const warning = stderr?.trim() || error.message;
          log.warn({ scriptPath, exitCode: (error as NodeJS.ErrnoException).code, stderr: stderr?.trim() }, `Post-processing script failed: ${warning}`);
          resolve({ success: false, warning });
        }
        return;
      }

      log.info({ scriptPath, audiobookPath }, 'Post-processing script completed successfully');
      resolve({ success: true });
    });
  });
}
