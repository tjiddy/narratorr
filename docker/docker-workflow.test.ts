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
    it('triggers on tag push matching v* pattern', () => {
      const wf = load();
      // Should have push.tags containing v*
      expect(wf).toMatch(/push:\s*\n\s+tags:\s*\[.*v\*/);
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
    it('defines IMAGE_NAME env var and uses it for :latest tag', () => {
      const wf = load();
      expect(wf).toContain('IMAGE_NAME: narratorr/narratorr');
      expect(wf).toContain('IMAGE_NAME }}:latest');
    });

    it('writes version and major_minor outputs from the tag ref', () => {
      const wf = load();
      expect(wf).toContain('GITHUB_REF_NAME');
      expect(wf).toMatch(/version=.*\$.*VERSION/);
      expect(wf).toMatch(/major_minor=.*\$.*MAJOR_MINOR/);
    });

    it('publishes versioned tag from steps.version.outputs.version', () => {
      const wf = load();
      expect(wf).toContain('${{ steps.version.outputs.version }}');
    });

    it('publishes major.minor tag from steps.version.outputs.major_minor', () => {
      const wf = load();
      expect(wf).toContain('${{ steps.version.outputs.major_minor }}');
    });
  });

  describe('registry authentication', () => {
    it('uses docker/login-action with DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets', () => {
      const wf = load();
      expect(wf).toContain('docker/login-action');
      expect(wf).toContain('DOCKERHUB_USERNAME');
      expect(wf).toContain('DOCKERHUB_TOKEN');
    });

    it('validates credentials are present before build and fails with clear error', () => {
      const wf = load();
      expect(wf).toContain('Validate registry credentials');
      expect(wf).toContain('Registry credentials missing. Set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets.');
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
