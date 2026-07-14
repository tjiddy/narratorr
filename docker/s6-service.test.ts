import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
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
      // node and the entry point may be on separate lines via shell continuation
      expect(content).toContain('node');
      expect(content).toContain('dist/server/index.js');
    });

    it('run script enables source maps so production stack traces map to TS source', () => {
      const content = fs.readFileSync(path.join(serviceDir, 'run'), 'utf-8');
      expect(content).toContain('--enable-source-maps');
    });

    it('run script enables Node crash reporting for diagnosing native faults', () => {
      const content = fs.readFileSync(path.join(serviceDir, 'run'), 'utf-8');
      expect(content).toContain('--report-on-fatalerror');
      expect(content).toContain('--report-uncaught-exception');
      expect(content).toContain('--report-directory=/config/crash-reports');
    });

    it('finish script exists and logs node exit code/signal for sub-JS crash diagnosis', () => {
      const finishPath = path.join(serviceDir, 'finish');
      expect(fs.existsSync(finishPath)).toBe(true);
      const content = fs.readFileSync(finishPath, 'utf-8');
      expect(content).toContain('s6 finish');
      expect(content).toContain('exitCode');
      expect(content).toContain('signalNumber');
    });

    it.skipIf(process.platform === 'win32')(
      'finish script logs clean-exit JSON when no signal arg given',
      () => {
        const finishPath = path.join(serviceDir, 'finish');
        const result = spawnSync('bash', [finishPath, '0', ''], {
          encoding: 'utf-8',
          timeout: 5000,
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stderr.trim());
        expect(parsed.level).toBe(60);
        expect(parsed.exitCode).toBe(0);
        expect(parsed.signalNumber).toBeUndefined();
        expect(parsed.msg).toContain('exited');
        expect(parsed.msg).not.toContain('killed');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'finish script logs killed-by-signal JSON when signal number given',
      () => {
        const finishPath = path.join(serviceDir, 'finish');
        const result = spawnSync('bash', [finishPath, '256', '11'], {
          encoding: 'utf-8',
          timeout: 5000,
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stderr.trim());
        expect(parsed.level).toBe(60);
        expect(parsed.exitCode).toBe(256);
        expect(parsed.signalNumber).toBe(11);
        expect(parsed.msg).toContain('killed by signal');
      },
    );

    it('finish script is committed with executable permissions', () => {
      const finishGitPath = 'docker/root/etc/s6-overlay/s6-rc.d/svc-narratorr/finish';
      const output = execFileSync('git', ['ls-tree', 'HEAD', '--', finishGitPath], { encoding: 'utf-8' });
      // Git tracks executable files as mode 100755 — without it, s6 won't run the finish hook
      expect(output).toMatch(/^100755\s/);
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

  describe('init-narratorr-config oneshot (PUID/PGID /config chown fix)', () => {
    const initServiceDir = path.join(
      rootDir,
      'etc',
      's6-overlay',
      's6-rc.d',
      'init-narratorr-config',
    );

    it('type file contains "oneshot"', () => {
      const content = fs.readFileSync(path.join(initServiceDir, 'type'), 'utf-8').trim();
      expect(content).toBe('oneshot');
    });

    it('run and up scripts exist', () => {
      expect(fs.existsSync(path.join(initServiceDir, 'run'))).toBe(true);
      expect(fs.existsSync(path.join(initServiceDir, 'up'))).toBe(true);
    });

    it('up file points at the run script (LSIO oneshot indirection)', () => {
      const content = fs.readFileSync(path.join(initServiceDir, 'up'), 'utf-8').trim();
      expect(content).toBe('/etc/s6-overlay/s6-rc.d/init-narratorr-config/run');
    });

    it('run script is committed with executable permissions', () => {
      const runPath = 'docker/root/etc/s6-overlay/s6-rc.d/init-narratorr-config/run';
      const output = execFileSync('git', ['ls-tree', 'HEAD', '--', runPath], { encoding: 'utf-8' });
      // Git tracks executable files as mode 100755 — s6 silently skips a non-executable run script
      expect(output).toMatch(/^100755\s/);
    });

    it('run script uses the with-contenv bash shebang', () => {
      const content = fs.readFileSync(path.join(initServiceDir, 'run'), 'utf-8');
      expect(content).toMatch(/^#!\/usr\/bin\/with-contenv bash/);
    });

    it('run script recursively chowns /config to the app user', () => {
      const content = fs.readFileSync(path.join(initServiceDir, 'run'), 'utf-8');
      // Assert against the actual executable command, not raw content — the header
      // comment also mentions chown/abc//config, so a token-only match would still
      // pass if the real command were deleted or no-op'd. Strip comment/blank lines
      // first so this fails when the load-bearing chown is removed or altered.
      const executable = content
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
        .join('\n');
      expect(executable).toMatch(/(?:lsiown|chown)\s+-R\s+abc:abc\s+\/config\b/);
    });

    it('run script does NOT touch the media mounts (scope guard)', () => {
      const content = fs.readFileSync(path.join(initServiceDir, 'run'), 'utf-8');
      expect(content).not.toContain('/audiobooks');
      expect(content).not.toContain('/downloads');
    });

    it('run script fails gracefully — warns rather than hard-exiting on chown failure', () => {
      const content = fs.readFileSync(path.join(initServiceDir, 'run'), 'utf-8');
      // A `|| <warn>` fallback keeps the s6-rc bring-up alive so the app still boots.
      expect(content).toContain('||');
      expect(content).not.toMatch(/^\s*exit\s+1\b/m);
    });

    it.skipIf(process.platform === 'win32')(
      'run script exits 0 and warns when the chown cannot complete (graceful boot)',
      () => {
        const runPath = path.join(initServiceDir, 'run');
        // Determinism (F2): don't rely on the host lacking `lsiown` or `/config`.
        // Invoke an absolute bash with a controlled PATH pointing at an empty temp
        // dir, so the ownership command (lsiown/chown) is guaranteed unresolvable
        // and the `||` fallback always fires. `echo` is a bash builtin, so the
        // warning still emits under the stripped PATH. This proves the graceful
        // path independent of ambient host state.
        const bashBin = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
        expect(bashBin, 'no absolute bash found for deterministic invocation').toBeDefined();
        const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratorr-nopath-'));
        try {
          const result = spawnSync(bashBin as string, [runPath], {
            encoding: 'utf-8',
            timeout: 5000,
            env: { PATH: emptyPathDir },
          });
          expect(result.status).toBe(0);
          expect(result.stdout).toContain('WARNING');
          expect(result.stdout).toContain('/config');
        } finally {
          fs.rmSync(emptyPathDir, { recursive: true, force: true });
        }
      },
    );

    it('depends on the base image init-adduser (runs after PUID/PGID remap)', () => {
      const depPath = path.join(initServiceDir, 'dependencies.d', 'init-adduser');
      expect(fs.existsSync(depPath)).toBe(true);
    });

    it('svc-narratorr depends on init-narratorr-config (app starts after chown)', () => {
      const depPath = path.join(serviceDir, 'dependencies.d', 'init-narratorr-config');
      expect(fs.existsSync(depPath)).toBe(true);
    });

    it('is registered in user/contents.d/', () => {
      const registrationPath = path.join(
        rootDir,
        'etc',
        's6-overlay',
        's6-rc.d',
        'user',
        'contents.d',
        'init-narratorr-config',
      );
      expect(fs.existsSync(registrationPath)).toBe(true);
    });
  });

  describe('Dockerfile LSIO base image', () => {
    it('runner stage uses ghcr.io/linuxserver/baseimage-alpine:3.23', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('FROM ghcr.io/linuxserver/baseimage-alpine:3.23');
    });

    it('builder stage uses node:24-alpine3.23', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('FROM node:24-alpine3.23 AS builder');
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

    it('deps stage uses node:24-alpine3.23', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('FROM node:24-alpine3.23 AS deps');
    });

    it('runner copies Node binary from builder stage', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('COPY --from=builder /usr/local/bin/node /usr/local/bin/node');
    });

    it('runner copies node_modules from deps stage', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('COPY --from=deps /app/node_modules ./node_modules');
    });

    it('builder stage copies drizzle/ migration files', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      const builderSection = content.split('AS deps')[0];
      expect(builderSection).toContain('COPY drizzle/ drizzle/');
    });

    it('runner copies drizzle/ from builder stage', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('COPY --from=builder /app/drizzle ./drizzle');
    });

    it('runner does NOT use apk to install nodejs', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).not.toMatch(/apk\s.*nodejs/);
    });

    it('runner does NOT run corepack enable in runner stage', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      // corepack enable should only appear in builder/deps stages, not after the runner FROM
      const runnerSection = content.split('AS runner')[1];
      expect(runnerSection).not.toContain('corepack enable');
    });

    it('runner does NOT run pnpm install in runner stage', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      const runnerSection = content.split('AS runner')[1];
      expect(runnerSection).not.toContain('pnpm install');
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

    it('CONFIG_PATH, DATABASE_URL env defaults are set', () => {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      expect(content).toContain('ENV CONFIG_PATH=/config');
      expect(content).toContain('ENV DATABASE_URL=file:/config/narratorr.db');
      expect(content).not.toContain('ENV LIBRARY_PATH');
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
      expect(content).toContain('DATABASE_URL=file:/config/narratorr.db');
      expect(content).not.toContain('LIBRARY_PATH');
    });

    it('includes PUID and PGID environment variables', () => {
      const content = fs.readFileSync(composeFile, 'utf-8');
      expect(content).toMatch(/^\s+- PUID=/m);
      expect(content).toMatch(/^\s+- PGID=/m);
    });
  });
});
