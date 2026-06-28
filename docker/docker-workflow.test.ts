import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'docker.yml');
const composePath = path.join(__dirname, '..', 'docker-compose.yml');

describe('Docker CI workflow (.github/workflows/docker.yml)', () => {
  let content: string;

  // Load once — all tests read the same file
  function load(): string {
    if (!content) {
      content = fs.readFileSync(workflowPath, 'utf-8');
    }
    return content;
  }

  describe('trigger configuration', () => {
    it('triggers dev-channel builds on push to develop', () => {
      const wf = load();
      expect(wf).toMatch(/push:\s*\n\s+branches:\s*\[develop\]/);
    });

    it('triggers release-channel builds only on strict semver tags', () => {
      const wf = load();
      // vX.Y.Z only — dev milestone tags like v1219_01 must NOT match this filter
      expect(wf).toContain("tags: ['v[0-9]+.[0-9]+.[0-9]+']");
    });

    it('does not trigger on pull request', () => {
      const wf = load();
      expect(wf).not.toContain('pull_request');
    });
  });

  describe('quality gates', () => {
    it('docker job depends on quality-gates job', () => {
      const wf = load();
      expect(wf).toMatch(/needs:.*quality-gates/);
    });
  });

  describe('multi-arch build setup', () => {
    it('uses docker/setup-qemu-action for cross-platform emulation', () => {
      expect(load()).toContain('docker/setup-qemu-action');
    });

    it('uses docker/setup-buildx-action for multi-platform builds', () => {
      expect(load()).toContain('docker/setup-buildx-action');
    });

    it('builds for linux/amd64 and linux/arm64 platforms', () => {
      const wf = load();
      expect(wf).toContain('linux/amd64');
      expect(wf).toContain('linux/arm64');
    });

    it('verifies multi-arch manifest after push with imagetools inspect', () => {
      const wf = load();
      expect(wf).toContain('docker buildx imagetools inspect');
      expect(wf).toContain('Verify multi-arch manifest');
      expect(wf).toContain('Multi-arch manifest missing linux/amd64');
      expect(wf).toContain('Multi-arch manifest missing linux/arm64');
    });
  });

  describe('image tagging', () => {
    it('defines IMAGE_NAME env var for the Docker Hub repo', () => {
      expect(load()).toContain('IMAGE_NAME: narratorr/narratorr');
    });

    it('generates the tag matrix with docker/metadata-action', () => {
      expect(load()).toContain('docker/metadata-action');
    });

    it('dual-publishes to Docker Hub and GHCR from the generated tag list', () => {
      const wf = load();
      expect(wf).toContain('ghcr.io/${{ github.repository }}');
      expect(wf).toContain('tags: ${{ steps.meta.outputs.tags }}');
    });

    it('emits version + major.minor tags on semver release tags', () => {
      const wf = load();
      expect(wf).toContain('type=semver,pattern={{version}}');
      expect(wf).toContain('type=semver,pattern={{major}}.{{minor}}');
    });

    it('emits the :develop tag on non-tag (dev channel) refs', () => {
      const wf = load();
      expect(wf).toMatch(/type=raw,value=develop,enable=\$\{\{\s*github\.ref_type\s*!=\s*'tag'/);
    });

    it('stamps GIT_TAG build-arg (real tag on release, develop-<sha> on dev)', () => {
      const wf = load();
      expect(wf).toContain('GIT_TAG=${{ steps.vars.outputs.git_tag }}');
      expect(wf).toContain('git_tag=develop-${GITHUB_SHA::7}');
    });
  });

  describe('registry authentication', () => {
    it('logs in to Docker Hub with DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets', () => {
      const wf = load();
      expect(wf).toContain('docker/login-action');
      expect(wf).toContain('DOCKERHUB_USERNAME');
      expect(wf).toContain('DOCKERHUB_TOKEN');
    });

    it('logs in to GHCR with the built-in GITHUB_TOKEN', () => {
      const wf = load();
      expect(wf).toContain('registry: ghcr.io');
      expect(wf).toContain('secrets.GITHUB_TOKEN');
    });

    it('validates Docker Hub credentials before build and fails with a clear error', () => {
      const wf = load();
      expect(wf).toContain('Validate Docker Hub credentials');
      expect(wf).toContain('Registry credentials missing. Set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets.');
    });
  });

  describe('release channel', () => {
    it('cuts a GitHub Release only on tag (release) refs', () => {
      const wf = load();
      expect(wf).toContain('softprops/action-gh-release');
      expect(wf).toMatch(/if:\s*github\.ref_type == 'tag'/);
    });

    it('grants the permissions needed for GHCR push and Release creation', () => {
      const wf = load();
      expect(wf).toContain('packages: write');
      expect(wf).toContain('contents: write');
    });
  });

  describe('no auto-deploy (build/publish only)', () => {
    it('does not deploy to production via Portainer', () => {
      const wf = load();
      expect(wf).not.toContain('PORTAINER_WEBHOOK_URL');
      expect(wf).not.toMatch(/Deploy to production/i);
    });
  });

  describe('smoke test', () => {
    it('includes a container health check step using docker run', () => {
      const wf = load();
      expect(wf).toContain('docker run');
      expect(wf).toContain('/api/health');
    });

    it('checks for HTTP 200 status code', () => {
      const wf = load();
      expect(wf).toContain('200');
      expect(wf).toMatch(/http_code|HTTP_STATUS/i);
    });

    it('waits up to 30 seconds for health endpoint', () => {
      const wf = load();
      expect(wf).toMatch(/seq 1 30|timeout.*30/);
    });
  });

  describe('ffmpeg-8 dependency guard (#1679)', () => {
    it('runs ffmpeg -version inside the built image', () => {
      const wf = load();
      expect(wf).toContain('ffmpeg -version');
    });

    it('parses the ffmpeg major numerically and fails the build when it is < 8', () => {
      const wf = load();
      // Numeric capture (not a substring grep) followed by an integer `-lt 8` compare.
      expect(wf).toMatch(/FFMPEG_MAJOR=.*sed/);
      expect(wf).toMatch(/\$FFMPEG_MAJOR"?\s+-lt\s+8/);
      expect(wf).toContain('xHE-AAC/USAC decode regression (#1679)');
    });

    it('verifies ffprobe exists and is executable at its resolved path', () => {
      const wf = load();
      expect(wf).toContain('command -v ffprobe');
      expect(wf).toMatch(/test -x "\$FFPROBE_PATH"/);
      expect(wf).toContain('ffprobe missing or not executable');
    });
  });

  describe('image size reporting', () => {
    it('logs image size as informational output', () => {
      const wf = load();
      expect(wf).toMatch(/docker\s+(image\s+)?inspect|docker\s+images/i);
    });
  });
});

describe('docker-compose.yml published image', () => {
  it('references a registry image instead of build: .', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    expect(content).toMatch(/image:\s*narratorr\/narratorr/);
    expect(content).not.toMatch(/^\s+build:\s*\.\s*$/m);
  });

  it('includes a comment showing how to use local build instead', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    expect(content).toMatch(/#.*build/i);
  });
});
