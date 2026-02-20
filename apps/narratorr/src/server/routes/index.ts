import { type FastifyInstance } from 'fastify';
import { type Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  SettingsService,
  IndexerService,
  DownloadClientService,
  BookService,
  DownloadService,
  MetadataService,
  NotifierService,
  BlacklistService,
  ProwlarrSyncService,
} from '../services';
import { ImportService } from '../services/import.service.js';
import { LibraryScanService } from '../services/library-scan.service.js';
import { MatchJobService } from '../services/match-job.service.js';

import { booksRoutes, bookFilesRoute } from './books.js';
import { searchRoutes } from './search.js';
import { activityRoutes } from './activity.js';
import { indexersRoutes } from './indexers.js';
import { downloadClientsRoutes } from './download-clients.js';
import { settingsRoutes } from './settings.js';
import { systemRoutes } from './system.js';
import { metadataRoutes } from './metadata.js';
import { libraryScanRoutes } from './library-scan.js';
import { notifiersRoutes } from './notifiers.js';
import { blacklistRoutes } from './blacklist.js';
import { prowlarrRoutes } from './prowlarr.js';

export interface Services {
  settings: SettingsService;
  indexer: IndexerService;
  downloadClient: DownloadClientService;
  book: BookService;
  download: DownloadService;
  metadata: MetadataService;
  import: ImportService;
  libraryScan: LibraryScanService;
  matchJob: MatchJobService;
  notifier: NotifierService;
  blacklist: BlacklistService;
  prowlarrSync: ProwlarrSyncService;
}

export async function createServices(db: Db, log: FastifyBaseLogger): Promise<Services> {
  const settings = new SettingsService(db, log);
  const indexer = new IndexerService(db, log);
  const downloadClient = new DownloadClientService(db, log);

  // Load metadata settings for Audible region
  const metadataSettings = await settings.get('metadata');
  const metadata = new MetadataService(log, {
    audibleRegion: metadataSettings?.audibleRegion,
  });

  const book = new BookService(db, log, metadata);
  const notifier = new NotifierService(db, log);
  const download = new DownloadService(db, downloadClient, log, notifier);
  const importService = new ImportService(db, downloadClient, settings, log, notifier);
  const libraryScan = new LibraryScanService(db, book, metadata, settings, log);
  const matchJob = new MatchJobService(metadata, log);
  const blacklistService = new BlacklistService(db, log);
  const prowlarrSync = new ProwlarrSyncService(db, log);

  return { settings, indexer, downloadClient, book, download, metadata, import: importService, libraryScan, matchJob, notifier, blacklist: blacklistService, prowlarrSync };
}

export async function registerRoutes(
  app: FastifyInstance,
  services: Services
): Promise<void> {
  await booksRoutes(app, services.book, services.download);
  await bookFilesRoute(app, services.book);
  await searchRoutes(app, services.indexer, services.download, services.blacklist);
  await activityRoutes(app, services.download);
  await indexersRoutes(app, services.indexer);
  await downloadClientsRoutes(app, services.downloadClient);
  await settingsRoutes(app, services.settings);
  await metadataRoutes(app, services.metadata);
  await libraryScanRoutes(app, services.libraryScan, services.matchJob);
  await systemRoutes(app, services);
  await notifiersRoutes(app, services.notifier);
  await blacklistRoutes(app, services.blacklist);
  await prowlarrRoutes(app, services.prowlarrSync);
}
