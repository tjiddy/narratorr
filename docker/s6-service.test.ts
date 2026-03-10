import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'root');
const serviceDir = path.join(rootDir, 'etc', 's6-overlay', 's6-rc.d', 'svc-narratorr');
const dockerfile = path.join(__dirname, '..', 'Dockerfile');
const composeFile = path.join(__dirname, '..', 'docker-compose.yml');

describe('s6-overlay service definition', () => {
  describe('service file structure', () => {
    it('type file contains "longrun"', () => {
      const content = fs.readFileSync(path.join(serviceDir, 'type'), 'utf-8').trim();
      expect(content).toBe('longrun');
    });

    it('run script exists', () => {
      expect(fs.existsSync(path.join(serviceDir, 'run'))).toBe(true);
    });

    it('run script is committed with executable permissions', () => {
      const runPath = 'docker/root/etc/s6-overlay/s6-rc.d/svc-narratorr/run';
      const output = execFileSync('git', ['ls-tree', 'HEAD', '--', runPath], { encoding: 'utf-8' });
      // Git tracks executable files as mode 100755
      expect(output).toMatch(/^100755\s/);
    });

    it('run script uses exec to start node (no background process)', () => {
      const content = fs.readFileSync(path.join(serviceDir, 'run'), 'utf-8');
      expect(content).toMatch(/exec\s/);
    });

    it('run script starts dist/server/index.js', () => {
      const content = fs.readFileSync(path.join(serviceDir, 'run'), 'utf-8');
      expect(content).toContain('node dist/server/index.js');
    });

    it('run script uses s6-setuidgid abc for LSIO user model', () => {
      const content = fs.readFileSync(path.join(serviceDir, 'run'), 'utf-8');
      expect(content).toContain('s6-setuidgid abc');
    });

    it('service is registered in user/contents.d/', () => {
      const registrationPath = path.join(rootDir, 'etc', 's6-overlay', 's6-rc.d', 'user', 'contents.d', 'svc-narratorr');
      expect(fs.existsSync(registrationPath)).toBe(true);
    });
  });

  describe('Dockerfile LSIO base image', () => {
    it('runner stage uses ghcr.io/linuxserver/baseimage-alpine:3.21', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('FROM ghcr.io/linuxserver/baseimage-alpine:3.21');
    });

    it('builder stage remains node:20-alpine', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('FROM node:20-alpine AS builder');
    });

    it('ffmpeg is installed in runner image', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('ffmpeg');
    });

    it('su-exec is NOT installed in runner image', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).not.toContain('su-exec');
    });

    it('entrypoint.sh is NOT copied into the image', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).not.toContain('entrypoint.sh');
    });

    it('copies s6 service files via COPY docker/root/', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('COPY docker/root/ /');
    });

    it('Node.js is installed in runner image via apk', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('nodejs');
    });

    it('does not set ENTRYPOINT (LSIO s6-overlay handles init)', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).not.toContain('ENTRYPOINT');
    });
  });

  describe('backwards compatibility', () => {
    it('EXPOSE 3000 is present', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('EXPOSE 3000');
    });

    it('volumes /config, /audiobooks, /downloads are defined', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('/config');
      expect(content).toContain('/audiobooks');
      expect(content).toContain('/downloads');
    });

    it('CONFIG_PATH, LIBRARY_PATH, DATABASE_URL env defaults are set', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('ENV CONFIG_PATH=/config');
      expect(content).toContain('ENV LIBRARY_PATH=/audiobooks');
      expect(content).toContain('ENV DATABASE_URL=file:/config/narratorr.db');
    });
  });

  describe('docker-compose.yml runtime contract', () => {
    it('exposes port 3000', () => {
      const content = fs.readFileSync(composeFile, 'utf-8');
      expect(content).toContain('"3000:3000"');
    });

    it('mounts /config, /audiobooks, and /downloads volumes', () => {
      const content = fs.readFileSync(composeFile, 'utf-8');
      expect(content).toContain(':/config');
      expect(content).toContain(':/audiobooks');
      expect(content).toContain(':/downloads');
    });

    it('includes required environment variables', () => {
      const content = fs.readFileSync(composeFile, 'utf-8');
      expect(content).toContain('CONFIG_PATH=/config');
      expect(content).toContain('LIBRARY_PATH=/audiobooks');
      expect(content).toContain('DATABASE_URL=file:/config/narratorr.db');
    });

    it('includes PUID and PGID environment variables', () => {
      const content = fs.readFileSync(composeFile, 'utf-8');
      expect(content).toMatch(/^\s+- PUID=/m);
      expect(content).toMatch(/^\s+- PGID=/m);
    });
  });
});
