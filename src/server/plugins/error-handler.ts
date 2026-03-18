import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';
import { RecyclingBinError } from '../services/recycling-bin.service.js';
import { RestoreUploadError } from '../services/backup.service.js';
import { QualityGateServiceError } from '../services/quality-gate.service.js';
import { EventHistoryServiceError } from '../services/event-history.service.js';
import { UserExistsError, AuthConfigError, IncorrectPasswordError } from '../services/auth.service.js';
import { ScanInProgressError, LibraryPathError } from '../services/library-scan.service.js';

/** Maps typed error codes to HTTP status codes. */
// eslint-disable-next-line complexity -- linear error-class→status mapping, one block per service
function getStatusForError(error: unknown): number | null {
  if (error instanceof RenameError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404;
      case 'NO_PATH': return 400;
      case 'CONFLICT': return 409;
    }
  }

  if (error instanceof RetagError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404;
      case 'NO_PATH':
      case 'PATH_MISSING':
      case 'FFMPEG_NOT_CONFIGURED': return 400;
    }
  }

  if (error instanceof RecyclingBinError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404;
      case 'CONFLICT': return 409;
      case 'FILESYSTEM': return 500;
    }
  }

  if (error instanceof RestoreUploadError) {
    return 400;
  }

  if (error instanceof QualityGateServiceError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404;
      case 'INVALID_STATUS': return 409;
    }
  }

  if (error instanceof EventHistoryServiceError) {
    switch (error.code) {
      case 'NOT_FOUND':
      case 'DOWNLOAD_NOT_FOUND': return 404;
      case 'UNSUPPORTED_EVENT_TYPE':
      case 'NO_DOWNLOAD': return 400;
    }
  }

  if (error instanceof UserExistsError) return 409;
  if (error instanceof AuthConfigError) return 400;
  if (error instanceof IncorrectPasswordError) return 400;
  if (error instanceof ScanInProgressError) return 409;
  if (error instanceof LibraryPathError) return 400;

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
