import { connect } from 'node:net';

/**
 * TCP-connect probe for the fakes' listeners. The seed wrapper refuses to boot the app while any
 * fake port is unbound: a server whose first cron tick hits an unbound indexer port opens the
 * circuit breaker for ~60s and starves whichever spec searches inside that window (#2474).
 */

export interface WaitForTcpPortsOptions {
  host?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Resolves when every port accepts a TCP connection; rejects naming the stragglers at deadline. */
export async function waitForTcpPorts(ports: number[], options: WaitForTcpPortsOptions = {}): Promise<void> {
  const { host = '127.0.0.1', timeoutMs = 30_000, intervalMs = 200 } = options;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(ports);

  for (;;) {
    for (const port of [...pending]) {
      if (await tryConnect(port, host)) pending.delete(port);
    }
    if (pending.size === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForTcpPorts: not reachable on ${host} within ${timeoutMs}ms: ${[...pending].join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
