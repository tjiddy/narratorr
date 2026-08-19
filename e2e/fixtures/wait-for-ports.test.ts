import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { waitForTcpPorts } from './wait-for-ports.js';

function listen(port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port assigned'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await close(server);
  }
});

describe('waitForTcpPorts', () => {
  it('resolves once every port accepts a connection', async () => {
    const a = await listen();
    const b = await listen();
    servers.push(a.server, b.server);

    await expect(waitForTcpPorts([a.port, b.port], { timeoutMs: 2_000 })).resolves.toBeUndefined();
  });

  it('rejects at the deadline naming exactly the unreachable ports', async () => {
    const bound = await listen();
    servers.push(bound.server);
    // Bind then free a second port so the probe targets something recently guaranteed unbound.
    const freed = await listen();
    await close(freed.server);

    await expect(waitForTcpPorts([bound.port, freed.port], { timeoutMs: 400, intervalMs: 50 }))
      .rejects.toThrow(new RegExp(`^(?!.*\\b${bound.port}\\b).*\\b${freed.port}\\b`));
  });

  it('keeps polling until a late listener binds inside the deadline', async () => {
    const placeholder = await listen();
    const port = placeholder.port;
    await close(placeholder.server);

    // Bind the port only after the first probe attempts have failed.
    const bindLate = new Promise<void>((resolve) => {
      setTimeout(() => {
        void listen(port).then(({ server }) => {
          servers.push(server);
          resolve();
        });
      }, 250);
    });

    await expect(waitForTcpPorts([port], { timeoutMs: 5_000, intervalMs: 50 })).resolves.toBeUndefined();
    await bindLate;
  });
});
