import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BookImportService } from '../services/book-import.service.js';
import { importJobStatusSchema, type ImportJobStatus } from '../../shared/schemas/import-job.js';

const importJobsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((val, ctx): ImportJobStatus[] | undefined => {
      if (!val) return undefined;
      const statuses: ImportJobStatus[] = [];
      for (const part of val.split(',')) {
        const parsed = importJobStatusSchema.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid status: ${part}` });
          return z.NEVER;
        }
        statuses.push(parsed.data);
      }
      return statuses;
    }),
});

type ImportJobsQuery = z.infer<typeof importJobsQuerySchema>;

export async function importJobsRoutes(app: FastifyInstance, bookImportService: BookImportService) {
  app.get<{ Querystring: ImportJobsQuery }>(
    '/api/import-jobs',
    { schema: { querystring: importJobsQuerySchema } },
    async (request) => bookImportService.listImportJobs({ status: request.query.status }),
  );
}
