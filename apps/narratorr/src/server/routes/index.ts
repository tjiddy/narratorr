import { type FastifyInstance } from 'fastify';
import { type Db } from '@narratorr/db';
import {
  SettingsService,
  IndexerService,
  DownloadClientService,
  BookService,
  DownloadService,
  MetadataService,
} from '../services';

import { booksRoutes } from './books.js';
import { searchRoutes } from './search.js';
import { activityRoutes } from './activity.js';
import { indexersRoutes } from './indexers.js';
import { downloadClientsRoutes } from './download-clients.js';
import { settingsRoutes } from './settings.js';
import { systemRoutes } from './system.js';
import { metadataRoutes } from './metadata.js';

export interface Services {
  settings: SettingsService;
  indexer: IndexerService;
  downloadClient: DownloadClientService;
  book: BookService;
  download: DownloadService;
  metadata: MetadataService;
}

export function createServices(db: Db): Services {
  const settings = new SettingsService(db);
  const indexer = new IndexerService(db);
  const downloadClient = new DownloadClientService(db);
  const book = new BookService(db);
  const download = new DownloadService(db, downloadClient);
  const metadata = new MetadataService();

  return { settings, indexer, downloadClient, book, download, metadata };
}

export async function registerRoutes(
  app: FastifyInstance,
  services: Services
): Promise<void> {
  await booksRoutes(app, services.book);
  await searchRoutes(app, services.indexer, services.download);
  await activityRoutes(app, services.download);
  await indexersRoutes(app, services.indexer);
  await downloadClientsRoutes(app, services.downloadClient);
  await settingsRoutes(app, services.settings);
  await metadataRoutes(app, services.metadata);
  await systemRoutes(app);
}
