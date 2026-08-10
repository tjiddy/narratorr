import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SubmissionError, type ImportStagingService } from '../services/import-staging.service.js';
import type { ImportSubmissionReportService } from '../services/import-submission-report.service.js';
import {
  createSubmissionBodySchema,
  putItemsBodySchema,
  submissionQuerySchema,
  submissionListQuerySchema,
  submissionAttentionQuerySchema,
  submissionBulkDeleteQuerySchema,
  clientSubmissionIdSchema,
  SUBMISSION_ERROR_CODES,
} from '@core/import-staging/schemas.js';
import { serializeError } from '../utils/serialize-error.js';
import { idParamSchema } from '@shared/schemas/common.js';

const submissionIdParamSchema = idParamSchema;

const byClientParamSchema = z.object({ clientSubmissionId: clientSubmissionIdSchema });

// One staged item can approach 900 KiB; leave room for envelope overhead.
const PUT_BODY_LIMIT = 4 * 1024 * 1024;

function sendSubmissionError(reply: FastifyReply, err: SubmissionError): FastifyReply {
  return reply.status(err.httpStatus).send({ error: err.code, message: err.message, ...(err.gaps ? { gaps: err.gaps } : {}) });
}

/** Register staged upload, processing, and durable-report endpoints. */
export async function importSubmissionsRoutes(
  app: FastifyInstance,
  staging: ImportStagingService,
  report: ImportSubmissionReportService,
): Promise<void> {
  app.get('/api/import/submissions', async (request, reply) => {
    const parsed = submissionListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid-query', message: parsed.error.message });
    try {
      const result = await report.list(parsed.data);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      request.log.error({ error: serializeError(error) }, 'Staged import list failed');
      throw error;
    }
  });

  // Always return JSON; watch controls the client's polling cadence.
  app.get('/api/import/submissions/attention', async (request, reply) => {
    const parsed = submissionAttentionQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid-query', message: parsed.error.message });
    try {
      const result = await report.attention(parsed.data);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      request.log.error({ error: serializeError(error) }, 'Staged import attention read failed');
      throw error;
    }
  });

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

  // Detail uses the report projection to exclude itemPayload and accepted item bodies.
  app.get('/api/import/submissions/:id', async (request, reply) => {
    const idResult = submissionIdParamSchema.safeParse(request.params);
    if (!idResult.success) return reply.status(400).send({ error: 'invalid-id', message: 'Invalid submission id' });
    const queryResult = submissionQuerySchema.safeParse(request.query);
    if (!queryResult.success) return reply.status(400).send({ error: 'invalid-query', message: queryResult.error.message });
    try {
      const result = queryResult.data.includeItems
        ? await report.reportDetail(idResult.data.id)
        : await staging.getById(idResult.data.id, false);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error), submissionId: idResult.data.id }, 'Staged import GET by id failed');
      throw error;
    }
  });

  app.delete('/api/import/submissions/:id', async (request, reply) => {
    const idResult = submissionIdParamSchema.safeParse(request.params);
    if (!idResult.success) return reply.status(400).send({ error: 'invalid-id', message: 'Invalid submission id' });
    try {
      const result = await staging.deleteSubmission(idResult.data.id);
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      if (error instanceof SubmissionError) return sendSubmissionError(reply, error);
      request.log.error({ error: serializeError(error), submissionId: idResult.data.id }, 'Staged import delete failed');
      throw error;
    }
  });

  // The eligibility predicate is server-owned, so the clear accepts no parameters at all.
  app.delete('/api/import/submissions', async (request, reply) => {
    const parsed = submissionBulkDeleteQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid-query', message: parsed.error.message });
    try {
      const result = await staging.deleteCleanCompleted();
      return await reply.status(200).send(result);
    } catch (error: unknown) {
      request.log.error({ error: serializeError(error) }, 'Staged import bulk clear failed');
      throw error;
    }
  });

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
