import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQBitFake, type QBitFakeHandle } from './qbit.js';
import { buildTorrentBytes } from './torrent.js';

let nextPort = 14200;
function allocatePort(): number {
  return nextPort++;
}

describe('fake qBittorrent client', () => {
  let fake: QBitFakeHandle;
  let downloadsPath: string;
  let fixturePath: string;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    downloadsPath = mkdtempSync(join(tmpdir(), 'qbit-fake-downloads-'));
    const fixtureDir = mkdtempSync(join(tmpdir(), 'qbit-fake-fixtures-'));
    fixturePath = join(fixtureDir, 'silent.m4b');
    writeFileSync(fixturePath, Buffer.from('fake m4b bytes'));
    tempRoots.push(downloadsPath, fixtureDir);

    fake = await createQBitFake({
      port: allocatePort(),
      downloadsPath,
      fixturePath,
    });
  });

  afterEach(async () => {
    await fake.close();
    for (const p of tempRoots) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    tempRoots.length = 0;
  });

  async function login(): Promise<string> {
    const body = new URLSearchParams({ username: 'admin', password: 'adminadmin' });
    const res = await fetch(`${fake.url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(/SID=/);
    const match = /SID=([^;]+)/.exec(cookie!);
    return `SID=${match![1]}`;
  }

  async function addTorrent(cookie: string, torrentBytes: Buffer, savepath?: string): Promise<Response> {
    const form = new FormData();
    form.append(
      'torrents',
      new Blob([new Uint8Array(torrentBytes)], { type: 'application/x-bittorrent' }),
      'upload.torrent',
    );
    if (savepath) form.append('savepath', savepath);
    return fetch(`${fake.url}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
  }

  describe('POST /api/v2/auth/login', () => {
    it('returns Set-Cookie: SID=... on matching credentials', async () => {
      const cookie = await login();
      expect(cookie).toMatch(/^SID=/);
    });

    it('returns body "Fails." on wrong credentials', async () => {
      const body = new URLSearchParams({ username: 'admin', password: 'wrong' });
      const res = await fetch(`${fake.url}/api/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('Fails.');
    });
  });

  describe('POST /api/v2/torrents/add', () => {
    it('accepts a multipart upload and records the torrent', async () => {
      const cookie = await login();
      const torrent = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 14 });
      const res = await addTorrent(cookie, torrent);
      expect(res.status).toBe(200);
      expect(fake.listTorrents()).toHaveLength(1);
    });

    it('defaults save_path to the constructor-configured downloadsPath when savepath is absent', async () => {
      const cookie = await login();
      const torrent = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 14 });
      await addTorrent(cookie, torrent);
      const [t] = fake.listTorrents();
      expect(t.save_path).toBe(downloadsPath);
    });

    it('honors an explicit savepath if one is supplied', async () => {
      const cookie = await login();
      const alt = mkdtempSync(join(tmpdir(), 'qbit-fake-alt-'));
      tempRoots.push(alt);
      const torrent = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 14 });
      await addTorrent(cookie, torrent, alt);
      const [t] = fake.listTorrents();
      expect(t.save_path).toBe(alt);
    });

    it('rejects requests without a valid SID cookie with HTTP 403', async () => {
      const torrent = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 14 });
      const res = await addTorrent('SID=bogus', torrent);
      expect(res.status).toBe(403);
    });

    it('keys torrents by the info_hash extracted from the bencode', async () => {
      const cookie = await login();
      const torrent = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 14 });
      await addTorrent(cookie, torrent);
      const [t] = fake.listTorrents();
      expect(t.hash).toMatch(/^[0-9a-f]{40}$/);
    });

    it('returns 400 when the uploaded torrent bytes are missing or malformed', async () => {
      const cookie = await login();
      const form = new FormData();
      // No `torrents` file part.
      form.append('savepath', downloadsPath);
      const res = await fetch(`${fake.url}/api/v2/torrents/add`, {
        method: 'POST', headers: { Cookie: cookie }, body: form,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v2/torrents/info', () => {
    it('returns an empty array when no torrents have been added', async () => {
      const cookie = await login();
      const res = await fetch(`${fake.url}/api/v2/torrents/info`, { headers: { Cookie: cookie } });
      expect(await res.json()).toEqual([]);
    });

    it('returns the full torrent record with state=downloading after add', async () => {
      const cookie = await login();
      const torrent = buildTorrentBytes({ fileName: 'silent.m4b', fileLength: 14 });
      await addTorrent(cookie, torrent);
      const res = await fetch(`${fake.url}/api/v2/torrents/info`, { headers: { Cookie: cookie } });
      const arr = await res.json() as Array<Record<string, unknown>>;
      expect(arr).toHaveLength(1);
      expect(arr[0].state).toBe('downloading');
      expect(arr[0].progress).toBe(0);
      expect(arr[0].save_path).toBe(downloadsPath);
    });

    it('filters results by the hashes query param', async () => {
      const cookie = await login();
      await addTorrent(cookie, buildTorrentBytes({ fileName: 'a.m4b', fileLength: 10 }));
      await addTorrent(cookie, buildTorrentBytes({ fileName: 'b.m4b', fileLength: 10 }));
      const all = fake.listTorrents();
      expect(all).toHaveLength(2);

      const targetHash = all[0].hash;
      const res = await fetch(`${fake.url}/api/v2/torrents/info?hashes=${targetHash}`, {
        headers: { Cookie: cookie },
      });
      const arr = await res.json() as Array<{ hash: string }>;
      expect(arr).toHaveLength(1);
      expect(arr[0].hash).toBe(targetHash);
    });
  });

  describe('GET /api/v2/app/version', () => {
    it('returns a version string for the download-client test() probe', async () => {
      const res = await fetch(`${fake.url}/api/v2/app/version`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/^\d+\.\d+/);
    });
  });

  describe('POST /__control/complete', () => {
    it('flips state to uploading, sets progress=1, and stages the silent m4b fixture', async () => {
      const cookie = await login();
      const torrent = buildTorrentBytes({ fileName: 'e2e-test-book', fileLength: 14 });
      await addTorrent(cookie, torrent);
      const [t] = fake.listTorrents();

      const res = await fetch(`${fake.url}/__control/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: t.hash }),
      });
      expect(res.status).toBe(200);

      const [after] = fake.listTorrents();
      expect(after.state).toBe('uploading');
      expect(after.progress).toBe(1);
      expect(existsSync(join(downloadsPath, 'e2e-test-book', 'silent.m4b'))).toBe(true);
    });

    it('sets content_path to an absolute path inside save_path so mapState does not downgrade', async () => {
      const cookie = await login();
      const torrent = buildTorrentBytes({ fileName: 'my-book', fileLength: 14 });
      await addTorrent(cookie, torrent);
      const [t] = fake.listTorrents();

      await fetch(`${fake.url}/__control/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: t.hash }),
      });

      const [after] = fake.listTorrents();
      expect(after.content_path).toBeDefined();
      // mapState in qbittorrent.ts rejects content_path that isn't inside save_path via relative(save_path, content_path).
      expect(after.content_path!.startsWith(after.save_path)).toBe(true);
    });

    it('returns HTTP 404 for an unknown hash', async () => {
      const res = await fetch(`${fake.url}/__control/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: 'deadbeef' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('createQBitFake factory', () => {
    it('throws if the fixture file does not exist', async () => {
      await expect(
        createQBitFake({
          port: allocatePort(),
          downloadsPath,
          fixturePath: '/nonexistent/fixture.m4b',
        }),
      ).rejects.toThrow(/fixture not found/);
    });

    it('returns a handle exposing server, url, and close()', () => {
      expect(fake.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(typeof fake.close).toBe('function');
      expect(fake.server).toBeDefined();
    });
  });
});
