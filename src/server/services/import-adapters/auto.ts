import { autoImportJobPayloadSchema, type ImportAdapter, type ImportAdapterContext, type ImportJob, type AutoImportJobPayload } from './types.js';
import type { ImportOrchestrator } from '../import-orchestrator.js';

function parseAutoPayload(jobId: number, raw: string): AutoImportJobPayload {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Invalid auto import payload for job ${jobId}: malformed JSON`, { cause: error });
  }
  const result = autoImportJobPayloadSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Invalid auto import payload for job ${jobId}: shape mismatch`, { cause: result.error });
  }
  return result.data;
}

export class AutoImportAdapter implements ImportAdapter {
  readonly type = 'auto' as const;

  constructor(private importOrchestrator: ImportOrchestrator) {}

  async process(job: ImportJob, ctx: ImportAdapterContext): Promise<void> {
    const { log } = ctx;

    const bookId = job.bookId;
    if (bookId == null) {
      throw new Error('AutoImportAdapter requires a bookId on the job');
    }

    const payload: AutoImportJobPayload = parseAutoPayload(job.id, job.metadata);

    log.info({ bookId, downloadId: payload.downloadId }, 'Processing auto import');

    await ctx.setPhase('analyzing');

    // Delegate to ImportOrchestrator.importDownload() — the full side-effect wrapper.
    // This preserves all success/failure side effects: SSE, tagging, post-processing,
    // notifications, event history, blacklist + retry-search.
    await this.importOrchestrator.importDownload(payload.downloadId, {
      setPhase: ctx.setPhase,
      emitProgress: ctx.emitProgress,
    });
  }
}
