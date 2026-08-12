import { z } from 'zod';
import { clientStatusSchema, pipelineStageSchema, downloadStatusSchema, type ClientStatus, type PipelineStage } from '../activity.js';
import { deriveDisplayStatus } from '../../download-status-registry.js';
import { v1PaginationParamsSchema } from './common.js';
import { protocolSchema, type DownloadProtocol } from '../download-protocol.js';

// Expose canonical status axes plus a derived status so clients need not reproduce the projection.
export const downloadV1BookSchema = z
  .object({ id: z.string() })
  .strict()
  .nullable();

export const downloadV1Schema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: downloadStatusSchema,
    clientStatus: clientStatusSchema,
    pipelineStage: pipelineStageSchema,
    book: downloadV1BookSchema,
    protocol: protocolSchema,
    progress: z.number(),
    addedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    errorMessage: z.string().nullable(),
  })
  .strict();

export type DownloadV1 = z.infer<typeof downloadV1Schema>;

export const downloadV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type DownloadV1ListQuery = z.infer<typeof downloadV1ListQuerySchema>;

// book is absent when unlinked or deleted through its set-null foreign key.
export interface DownloadV1Source {
  publicId: string;
  title: string;
  clientStatus: ClientStatus;
  pipelineStage: PipelineStage;
  protocol: DownloadProtocol;
  progress: number;
  addedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  book?: { publicId: string };
}

export function toDownloadV1(row: DownloadV1Source): DownloadV1 {
  return {
    id: row.publicId,
    title: row.title,
    status: deriveDisplayStatus(row.clientStatus, row.pipelineStage),
    clientStatus: row.clientStatus,
    pipelineStage: row.pipelineStage,
    book: row.book ? { id: row.book.publicId } : null,
    protocol: row.protocol,
    progress: row.progress,
    addedAt: row.addedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    errorMessage: row.errorMessage,
  };
}
