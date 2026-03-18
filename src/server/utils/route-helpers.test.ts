import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { sendInternalError } from './route-helpers.js';

function createMockReply(): FastifyReply {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

describe('sendInternalError', () => {
  it('sends 500 with Internal server error message', () => {
    const reply = createMockReply();
    sendInternalError(reply);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('accepts optional custom message', () => {
    const reply = createMockReply();
    sendInternalError(reply, 'Custom failure');
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Custom failure' });
  });
});
