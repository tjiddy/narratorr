import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';
import { MergeError } from '../services/merge.service.js';
import { RecyclingBinError } from '../services/recycling-bin.service.js';
import { RestoreUploadError } from '../services/backup.service.js';
import { QualityGateServiceError } from '../services/quality-gate.service.js';
import { EventHistoryServiceError } from '../services/event-history.service.js';
import { UserExistsError, AuthConfigError, IncorrectPasswordError } from '../services/auth.service.js';
import { ScanInProgressError, LibraryPathError } from '../services/library-scan.service.js';
import { DownloadError } from '../services/download.service.js';
import { TaskRegistryError } from '../services/task-registry.js';

// ---------------------------------------------------------------------------
// Error → HTTP status registry
// ---------------------------------------------------------------------------

type ErrorEntry =
  | { type: 'flat'; status: number }
  | { type: 'coded'; codes: Record<string, number> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ERROR_REGISTRY = new Map<new (...args: any[]) => Error, ErrorEntry>([
  [RenameError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, CONFLICT: 409 } }],
  [MergeError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, NO_STATUS: 400, NO_TOP_LEVEL_FILES: 400, FFMPEG_NOT_CONFIGURED: 503, ALREADY_IN_PROGRESS: 409 } }],
  [RetagError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, PATH_MISSING: 400, FFMPEG_NOT_CONFIGURED: 400 } }],
  [RecyclingBinError, { type: 'coded', codes: { NOT_FOUND: 404, CONFLICT: 409, FILESYSTEM: 500 } }],
  [RestoreUploadError, { type: 'flat', status: 400 }],
  [QualityGateServiceError, { type: 'coded', codes: { NOT_FOUND: 404, INVALID_STATUS: 409 } }],
  [EventHistoryServiceError, { type: 'coded', codes: { NOT_FOUND: 404, DOWNLOAD_NOT_FOUND: 404, UNSUPPORTED_EVENT_TYPE: 400, NO_DOWNLOAD: 400 } }],
  [UserExistsError, { type: 'flat', status: 409 }],
  [AuthConfigError, { type: 'flat', status: 400 }],
  [IncorrectPasswordError, { type: 'flat', status: 400 }],
  [ScanInProgressError, { type: 'flat', status: 409 }],
  [LibraryPathError, { type: 'flat', status: 400 }],
  [DownloadError, { type: 'coded', codes: { NOT_FOUND: 404, NO_BOOK_LINKED: 404, INVALID_STATUS: 400 } }],
  [TaskRegistryError, { type: 'coded', codes: { NOT_FOUND: 404, ALREADY_RUNNING: 409 } }],
]);

/** Maps typed error codes to HTTP status codes. */
function getStatusForError(error: unknown): number | null {
  for (const [ErrorClass, entry] of ERROR_REGISTRY) {
    if (error instanceof ErrorClass) {
      if (entry.type === 'flat') return entry.status;
      const code = (error as { code?: string }).code;
      if (code && code in entry.codes) return entry.codes[code];
    }
  }
  return null;
}

async function errorHandlerPluginInner(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const status = getStatusForError(error);

    if (status !== null) {
      if (status >= 500) {
        request.log.error(error, error.message);
      } else {
        request.log.warn({ code: (error as { code?: string }).code }, error.message);
      }
      return reply.status(status).send({ error: error.message });
    }

    // Fastify validation errors (from schema validation) — preserve Fastify's default format
    if ('validation' in error && error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: error.message,
      });
    }

    // Untyped errors — 500 with generic message (no stack leak)
    request.log.error(error, error.message || 'Unhandled error');
    return reply.status(500).send({ error: 'Internal server error' });
  });
}

export const errorHandlerPlugin = fp(errorHandlerPluginInner, {
  name: 'error-handler',
});
