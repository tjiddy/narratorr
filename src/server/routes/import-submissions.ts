import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SubmissionError, type ImportStagingService } from '../services/import-staging.service.js';
import {
  createSubmissionBodySchema,
  putItemsBodySchema,
  submissionQuerySchema,
  clientSubmissionIdSchema,
  SUBMISSION_ERROR_CODES,
} from '../../core/import-staging/schemas.js';
import { serializeError } from '../utils/serialize-error.js';

/** Positive-integer :id path param (mirrors the shared idParamSchema contract). */
const submissionIdParamSchema = z.object({
  id: z.string().transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid ID' });
      return z.NEVER;
    }
    return parsed;
  }),
});

const byClientParamSchema = z.object({ clientSubmissionId: clientSubmissionIdSchema });

/** Per-route headroom: a single staged item can approach ~900 KiB + envelope. */
const PUT_BODY_LIMIT = 4 * 1024 * 1024; // 4 MiB

/** Map a thrown SubmissionError → its typed HTTP status + named code (+ gaps). */
function sendSubmissionError(reply: FastifyReply, err: SubmissionError): FastifyReply {
  return reply.status(err.httpStatus).send({ error: err.code, message: err.message, ...(err.gaps ? { gaps: err.gaps } : {}) });
}

/**
 * Staged import submission routes (#1893). Inert upload → finalize → server-owned
 * processing, plus the query-selected durable-record GETs. All bodies/queries are
 * validated with the strict core schemas; schema failures return a typed 400.
 */
export async function importSubmissionsRoutes(app: FastifyInstance, staging: ImportStagingService): Promise<void> {
  // Create-or-return by clientSubmissionId.
  app.post('/api/import/submissions', async (request, reply) => {
    const parsed = createSubmissionBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid-body', message: parsed.error.message });
    try {
      const result = await staging.createSubmission(parsed.data);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error) }, 'Staged import create failed');
      throw error;
    }
  });

  // Chunked inert upload.
  app.put('/api/import/submissions/:id/items', { bodyLimit: PUT_BODY_LIMIT }, async (request, reply) => {
    const idResult = submissionIdParamSchema.safeParse(request.params);
    if (!idResult.success) return reply.status(400).send({ error: 'invalid-id', message: 'Invalid submission id' });
    const bodyResult = putItemsBodySchema.safeParse(request.body);
    if (!bodyResult.success) return reply.status(400).send({ error: SUBMISSION_ERROR_CODES.itemInvalid, message: bodyResult.error.message });
    try {
      const result = await staging.putItems(idResult.data.id, bodyResult.data);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error) }, 'Staged import PUT failed');
      throw error;
    }
  });

  // Finalize (idempotent).
  app.post('/api/import/submissions/:id/finalize', async (request, reply) => {
    const idResult = submissionIdParamSchema.safeParse(request.params);
    if (!idResult.success) return reply.status(400).send({ error: 'invalid-id', message: 'Invalid submission id' });
    try {
      const result = await staging.finalize(idResult.data.id);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error) }, 'Staged import finalize failed');
      throw error;
    }
  });

  // Query-selected durable record by id.
  app.get('/api/import/submissions/:id', async (request, reply) => {
    const idResult = submissionIdParamSchema.safeParse(request.params);
    if (!idResult.success) return reply.status(400).send({ error: 'invalid-id', message: 'Invalid submission id' });
    const queryResult = submissionQuerySchema.safeParse(request.query);
    if (!queryResult.success) return reply.status(400).send({ error: 'invalid-query', message: queryResult.error.message });
    try {
      const result = await staging.getById(idResult.data.id, queryResult.data.includeItems);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error), submissionId: idResult.data.id }, 'Staged import GET by id failed');
      throw error;
    }
  });

  // Query-selected durable record by clientSubmissionId (by-client recovery lookup).
  app.get('/api/import/submissions/by-client/:clientSubmissionId', async (request, reply) => {
    const paramResult = byClientParamSchema.safeParse(request.params);
    if (!paramResult.success) return reply.status(400).send({ error: 'invalid-client-id', message: 'Invalid clientSubmissionId' });
    const queryResult = submissionQuerySchema.safeParse(request.query);
    if (!queryResult.success) return reply.status(400).send({ error: 'invalid-query', message: queryResult.error.message });
    try {
      const result = await staging.getByClientId(paramResult.data.clientSubmissionId, queryResult.data.includeItems);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error), clientSubmissionId: paramResult.data.clientSubmissionId }, 'Staged import GET by-client failed');
      throw error;
    }
  });
}
