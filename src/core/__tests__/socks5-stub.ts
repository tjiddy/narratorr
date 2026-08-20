/**
 * In-process RFC 1928 SOCKS5 listener, for driving a real undici `Socks5ProxyAgent` end to end.
 *
 * It records what the proxy actually observed — `{ atyp, host, port }` per CONNECT and the RFC 1929
 * credentials — because a test that only asserts a 200 would pass just as well if the request had
 * bypassed the proxy entirely, which is exactly how #2484's defect stayed green under a mock.
 *
 * The stub owns every socket it accepts and every upstream socket it opens; `close()` destroys them
 * all before closing the listener. That is what collapses a tunnel whose origin never responds.
 */

import net from 'node:net';

const SOCKS_VERSION = 0x05;
const AUTH_VERSION = 0x01;
export const ATYP_IPV4 = 0x01;
export const ATYP_DOMAIN = 0x03;
export const ATYP_IPV6 = 0x04;

const METHOD_NONE = 0x00;
const METHOD_USERPASS = 0x02;
const REPLY_SUCCESS = 0x00;
const REPLY_HOST_UNREACHABLE = 0x04;

export interface Socks5Connect {
  atyp: number;
  host: string;
  port: number;
}

export interface Socks5Credentials {
  username: string;
  password: string;
}

export interface Socks5StubOptions {
  /** Offer only RFC 1929 user/pass (method 0x02) instead of no-auth. */
  requireAuth?: boolean;
  /** Fail the auth sub-negotiation with `0x01 0x01`. Implies `requireAuth`. */
  rejectAuth?: boolean;
  /** Accept the TCP connection and never send a byte, so undici's own SOCKS5 timeout governs. */
  silent?: boolean;
  /**
   * Record the CONNECT and answer host-unreachable without dialing the target at all. Required for
   * any case whose target is a port the test does not own (the default-port derivation asks for
   * :80/:443): dialing those makes the outcome depend on whatever the runner happens to be running.
   */
  noUpstream?: boolean;
}

export interface Socks5Stub {
  readonly port: number;
  readonly url: string;
  readonly connects: Socks5Connect[];
  readonly credentials: Socks5Credentials[];
  /**
   * Dials the stub attempted against the target, counted immediately before `net.connect`. Distinct
   * from `connects`, which records the CONNECT frame the client sent — that happens in both modes.
   * This is the only observable that separates them, so it is what makes `noUpstream` deletable-with-
   * a-red-suite rather than a silent regression back to dialing host-owned ports.
   */
  readonly upstreamAttempts: number;
  close(): Promise<void>;
}

type Stage = 'greeting' | 'auth' | 'request' | 'tunnel';

function parseGreeting(buf: Buffer): { rest: Buffer } | null {
  if (buf.length < 2) return null;
  const nMethods = buf[1]!;
  if (buf.length < 2 + nMethods) return null;
  return { rest: buf.subarray(2 + nMethods) };
}

function parseAuth(buf: Buffer): { credentials: Socks5Credentials; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const ulen = buf[1]!;
  if (buf.length < 3 + ulen) return null;
  const plen = buf[2 + ulen]!;
  if (buf.length < 3 + ulen + plen) return null;
  return {
    credentials: {
      username: buf.subarray(2, 2 + ulen).toString('utf8'),
      password: buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8'),
    },
    rest: buf.subarray(3 + ulen + plen),
  };
}

function readAddress(buf: Buffer, atyp: number): { host: string; end: number } | null {
  if (atyp === ATYP_IPV4) {
    if (buf.length < 8) return null;
    return { host: Array.from(buf.subarray(4, 8)).join('.'), end: 8 };
  }
  if (atyp === ATYP_DOMAIN) {
    const len = buf[4]!;
    if (buf.length < 5 + len) return null;
    return { host: buf.subarray(5, 5 + len).toString('utf8'), end: 5 + len };
  }
  if (atyp === ATYP_IPV6) {
    if (buf.length < 20) return null;
    const groups: string[] = [];
    for (let i = 4; i < 20; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
    return { host: groups.join(':'), end: 20 };
  }
  return null;
}

function parseRequest(buf: Buffer): { connect: Socks5Connect; rest: Buffer } | null {
  if (buf.length < 5) return null;
  const atyp = buf[3]!;
  const address = readAddress(buf, atyp);
  if (!address) return null;
  if (buf.length < address.end + 2) return null;
  return {
    connect: { atyp, host: address.host, port: buf.readUInt16BE(address.end) },
    rest: buf.subarray(address.end + 2),
  };
}

function reply(code: number): Buffer {
  return Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

/** Start a loopback SOCKS5 listener. Resolves once it is accepting connections. */
export async function startSocks5Stub(options: Socks5StubOptions = {}): Promise<Socks5Stub> {
  const requireAuth = options.requireAuth === true || options.rejectAuth === true;
  const connects: Socks5Connect[] = [];
  const credentials: Socks5Credentials[] = [];
  const sockets = new Set<net.Socket>();
  let upstreamAttempts = 0;

  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };

  const openTunnel = (socket: net.Socket, target: Socks5Connect, buffered: Buffer): net.Socket | undefined => {
    if (options.noUpstream === true) {
      socket.end(reply(REPLY_HOST_UNREACHABLE));
      return undefined;
    }
    upstreamAttempts += 1;
    const upstream = net.connect(target.port, target.host);
    track(upstream);
    upstream.once('connect', () => {
      socket.write(reply(REPLY_SUCCESS));
      // Bytes that arrived in the same segment as the CONNECT request; dropping them truncates
      // the first HTTP request invisibly.
      if (buffered.length > 0) upstream.write(buffered);
      upstream.pipe(socket);
    });
    upstream.once('error', () => {
      if (socket.writable) socket.end(reply(REPLY_HOST_UNREACHABLE));
    });
    return upstream;
  };

  const server = net.createServer((socket) => {
    track(socket);
    if (options.silent === true) return;

    let stage: Stage = 'greeting';
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let upstream: net.Socket | undefined;

    const pump = (): void => {
      for (;;) {
        if (stage === 'greeting') {
          const parsed = parseGreeting(buf);
          if (!parsed) return;
          buf = parsed.rest;
          socket.write(Buffer.from([SOCKS_VERSION, requireAuth ? METHOD_USERPASS : METHOD_NONE]));
          stage = requireAuth ? 'auth' : 'request';
          continue;
        }
        if (stage === 'auth') {
          const parsed = parseAuth(buf);
          if (!parsed) return;
          buf = parsed.rest;
          credentials.push(parsed.credentials);
          if (options.rejectAuth === true) {
            socket.end(Buffer.from([AUTH_VERSION, 0x01]));
            return;
          }
          socket.write(Buffer.from([AUTH_VERSION, 0x00]));
          stage = 'request';
          continue;
        }
        const parsed = parseRequest(buf);
        if (!parsed) return;
        connects.push(parsed.connect);
        stage = 'tunnel';
        upstream = openTunnel(socket, parsed.connect, parsed.rest);
        buf = Buffer.alloc(0);
        return;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      // Client→upstream stays on this handler rather than `socket.pipe()`: a pipe would add a second
      // 'data' listener and every byte would be written twice.
      if (stage === 'tunnel') {
        upstream?.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      pump();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('SOCKS5 stub failed to bind');
  const { port } = address;

  return {
    port,
    url: `socks5://127.0.0.1:${port}`,
    connects,
    credentials,
    get upstreamAttempts(): number {
      return upstreamAttempts;
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
