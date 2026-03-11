import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { createIndexerSchema, updateIndexerSchema } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';

export async function indexersRoutes(app: FastifyInstance, indexerService: IndexerService) {
  await registerCrudRoutes(app, {
    basePath: '/api/indexers',
    entityName: 'Indexer',
    service: indexerService,
    createSchema: createIndexerSchema,
    updateSchema: updateIndexerSchema,
    secretEntity: 'indexer',
  });
}
