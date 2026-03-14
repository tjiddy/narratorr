import type { downloads } from '../../db/schema.js';

export type DownloadRow = typeof downloads.$inferSelect;
