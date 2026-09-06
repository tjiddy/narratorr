import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';
import { MergeError } from '../services/merge.service.js';
import { RestoreUploadError } from '../services/backup.service.js';
import { QualityGateServiceError } from '../services/quality-gate.service.js';
import { EventHistoryServiceError } from '../services/event-history.service.js';
import { UserExistsError, AuthConfigError, IncorrectPasswordError } from '../services/auth.service.js';
import { ScanInProgressError, LibraryPathError } from '../services/library-scan.service.js';
import { LibraryRootBusyError } from '../services/library-root-gate.js';
import { SeriesBindChurnError } from '../services/series-bind-admission.js';
import { DownloadError, DuplicateDownloadError } from '../services/download-errors.js';
import { TaskRegistryError } from '../services/task-registry.js';
import { BookRejectionError } from '../services/book-rejection.service.js';
import { RefreshScanError } from '../services/refresh-scan.service.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { CoverUploadError } from '../services/cover-upload.js';
import { DownloadClientError, DownloadClientAuthError, DownloadClientTimeoutError } from '@core/download-clients/errors.js';
import { SentinelOnNonSecretFieldError } from '../utils/secret-codec.js';
import { BackupRecoveryError, BackupAmbiguityError, MarkerPathConflictError } from '../utils/import-staging.js';
import { serializeError } from '../utils/serialize-error.js';
import { getErrorMessage } from '../utils/error-message.js';

type ErrorEntry =
  | { type: 'flat'; status: number }
  | { type: 'coded'; codes: Record<string, number> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ERROR_REGISTRY = new Map<new (...args: any[]) => Error, ErrorEntry>([
  // Every RenameError code must appear here; an unregistered one falls through to a generic 500.
  [RenameError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, CONFLICT: 409, TARGET_OCCUPIED: 409, STALE_PATH: 409 } }],
  [MergeError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, NO_STATUS: 400, NO_TOP_LEVEL_FILES: 400, FFMPEG_NOT_CONFIGURED: 503, ALREADY_IN_PROGRESS: 409, ALREADY_QUEUED: 409 } }],
  [RetagError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, PATH_MISSING: 400, MUTAGEN_NOT_CONFIGURED: 503 } }],
  [RestoreUploadError, { type: 'flat', status: 400 }],
  [QualityGateServiceError, { type: 'coded', codes: { NOT_FOUND: 404, INVALID_STATUS: 409 } }],
  [EventHistoryServiceError, { type: 'coded', codes: { NOT_FOUND: 404, DOWNLOAD_NOT_FOUND: 404, UNSUPPORTED_EVENT_TYPE: 400, NO_DOWNLOAD: 400 } }],
  [UserExistsError, { type: 'flat', status: 409 }],
  [AuthConfigError, { type: 'flat', status: 400 }],
  [IncorrectPasswordError, { type: 'flat', status: 400 }],
  [ScanInProgressError, { type: 'flat', status: 409 }],
  [LibraryRootBusyError, { type: 'flat', status: 409 }],
  [SeriesBindChurnError, { type: 'flat', status: 409 }],
  [LibraryPathError, { type: 'flat', status: 400 }],
  [DownloadError, { type: 'coded', codes: { NOT_FOUND: 404, NO_BOOK_LINKED: 404, BOOK_NOT_FOUND: 404, INVALID_STATUS: 400, IMPORTED_BOOK_NO_RETRY: 409 } }],
  [DuplicateDownloadError, { type: 'coded', codes: { ACTIVE_DOWNLOAD_EXISTS: 409, PIPELINE_ACTIVE: 409 } }],
  [TaskRegistryError, { type: 'coded', codes: { NOT_FOUND: 404, ALREADY_RUNNING: 409 } }],
  [BookRejectionError, { type: 'coded', codes: { NOT_FOUND: 404, NOT_IMPORTED: 400, NO_IDENTIFIERS: 400 } }],
  [RefreshScanError, { type: 'coded', codes: { NOT_FOUND: 404, NO_PATH: 400, PATH_MISSING: 400, NO_AUDIO_FILES: 400 } }],
  [PathOutsideLibraryError, { type: 'coded', codes: { PATH_OUTSIDE_LIBRARY: 400 } }],
  [CoverUploadError, { type: 'coded', codes: { NOT_FOUND: 404, INVALID_MIME: 400, NO_PATH: 400 } }],
  [DownloadClientAuthError, { type: 'flat', status: 401 }],
  [DownloadClientTimeoutError, { type: 'flat', status: 504 }],
  [DownloadClientError, { type: 'flat', status: 502 }],
  [SentinelOnNonSecretFieldError, { type: 'flat', status: 400 }],
  // Rename maps transient recovery to 503 and structural conflicts to 409;
  // asynchronous merges report the same failures through merge_failed.
  [BackupRecoveryError, { type: 'coded', codes: { BACKUP_RECOVERY_FAILED: 503 } }],
  [MarkerPathConflictError, { type: 'coded', codes: { MARKER_PATH_CONFLICT: 409 } }],
  // Two populated backup conventions are structural ambiguity, not a transient failure.
  [BackupAmbiguityError, { type: 'coded', codes: { BACKUP_AMBIGUOUS: 409 } }],
]);

function getStatusForError(error: unknown): number | null {
  for (const [ErrorClass, entry] of ERROR_REGISTRY) {
    if (error instanceof ErrorClass) {
      if (entry.type === 'flat') return entry.status;
      const code = (error as { code?: string }).code;
      if (code && code in entry.codes) return entry.codes[code]!;
    }
  }
  return null;
}

async function errorHandlerPluginInner(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const status = getStatusForError(error);

    if (status !== null) {
      if (status >= 500) {
        // `narratorr/no-raw-error-logging` cannot see this: `error` is the handler's own parameter,
        // not a catch binding, so the serialization is by hand (#2604 AC7). Pino writes argument 1
        // as `msg`, so the message slot needs the text chokepoint even though argument 0 is
        // serialized — a registry-mapped error authors its own message, making this a no-op today.
        request.log.error({ error: serializeError(error) }, getErrorMessage(error));
      } else {
        request.log.warn({ code: (error as { code?: string }).code }, error.message);
      }
      return reply.status(status).send({ error: error.message });
    }

    // Preserve Fastify's validation response shape.
    if ('validation' in error && error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: error.message,
      });
    }

    // Pass through only FST_-coded 4xx; broader statusCode handling could leak 5xx
    // or arbitrary thrown-object messages.
    const fstError = error as { code?: string; statusCode?: number };
    if (
      fstError.code?.startsWith('FST_') &&
      typeof fstError.statusCode === 'number' &&
      fstError.statusCode >= 400 &&
      fstError.statusCode < 500
    ) {
      request.log.warn({ code: fstError.code, statusCode: fstError.statusCode }, error.message);
      return reply.status(fstError.statusCode).send({ error: error.message });
    }

    // Untyped failures get a generic response with no stack or message leak. Same parameter-rooted
    // blind spot as the 5xx arm above: raw, Pino would publish a DrizzleQueryError's `params` —
    // through argument 0 as own-enumerable fields, AND through argument 1, which Pino writes as
    // `msg`. This is the arm a DrizzleQueryError actually reaches, so both slots are routed.
    request.log.error({ error: serializeError(error) }, getErrorMessage(error) || 'Unhandled error');
    return reply.status(500).send({ error: 'Internal server error' });
  });
}

export const errorHandlerPlugin = fp(errorHandlerPluginInner, {
  name: 'error-handler',
});
