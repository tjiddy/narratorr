import { type FastifyInstance } from 'fastify';
import { type NotifierService } from '../services';
import {
  idParamSchema,
  createNotifierSchema,
  updateNotifierSchema,
  type CreateNotifierInput,
  type UpdateNotifierInput,
} from '../../shared/schemas.js';

export async function notifiersRoutes(app: FastifyInstance, notifierService: NotifierService) {
  // GET /api/notifiers
  app.get('/api/notifiers', async (request, reply) => {
    try {
      return notifierService.getAll();
    } catch (error) {
      request.log.error(error, 'Failed to fetch notifiers');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/notifiers/:id
  app.get(
    '/api/notifiers/:id',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const notifier = await notifierService.getById(id);

        if (!notifier) {
          return reply.status(404).send({ error: 'Notifier not found' });
        }

        return notifier;
      } catch (error) {
        request.log.error(error, 'Failed to fetch notifier');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/notifiers
  app.post(
    '/api/notifiers',
    {
      schema: {
        body: createNotifierSchema,
      },
    },
    async (request, reply) => {
      try {
        const data = request.body as CreateNotifierInput;
        const notifier = await notifierService.create(data);
        request.log.info({ name: data.name }, 'Notifier created');
        return reply.status(201).send(notifier);
      } catch (error) {
        request.log.error(error, 'Failed to create notifier');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // PUT /api/notifiers/:id
  app.put(
    '/api/notifiers/:id',
    {
      schema: {
        params: idParamSchema,
        body: updateNotifierSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const data = request.body as UpdateNotifierInput;
        const notifier = await notifierService.update(id, data);

        if (!notifier) {
          return reply.status(404).send({ error: 'Notifier not found' });
        }

        request.log.info({ id }, 'Notifier updated');
        return notifier;
      } catch (error) {
        request.log.error(error, 'Failed to update notifier');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // DELETE /api/notifiers/:id
  app.delete(
    '/api/notifiers/:id',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };

      try {
        const deleted = await notifierService.delete(id);

        if (!deleted) {
          return reply.status(404).send({ error: 'Notifier not found' });
        }

        request.log.info({ id }, 'Notifier deleted');
        return { success: true };
      } catch (error) {
        request.log.error({ id, error }, 'Failed to delete notifier');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete',
        });
      }
    }
  );

  // POST /api/notifiers/test (test config without persisting)
  app.post(
    '/api/notifiers/test',
    {
      schema: {
        body: createNotifierSchema,
      },
    },
    async (request) => {
      const data = request.body as CreateNotifierInput;
      const result = await notifierService.testConfig({
        type: data.type,
        settings: data.settings as Record<string, unknown>,
      });
      request.log.debug({ type: data.type, success: result.success }, 'Notifier config test result');
      return result;
    }
  );

  // POST /api/notifiers/:id/test
  app.post(
    '/api/notifiers/:id/test',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const result = await notifierService.test(id);
      request.log.debug({ id, success: result.success }, 'Notifier test result');
      return result;
    }
  );
}
