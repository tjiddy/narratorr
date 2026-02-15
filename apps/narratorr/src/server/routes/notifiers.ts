import { type FastifyInstance } from 'fastify';
import { type NotifierService } from '../services';
import { createNotifierSchema, updateNotifierSchema } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';

export async function notifiersRoutes(app: FastifyInstance, notifierService: NotifierService) {
  await registerCrudRoutes(app, {
    basePath: '/api/notifiers',
    entityName: 'Notifier',
    service: notifierService,
    createSchema: createNotifierSchema,
    updateSchema: updateNotifierSchema,
  });
}
