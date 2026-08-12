import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dockerfile = path.join(__dirname, '..', 'Dockerfile');
const dockerignore = path.join(__dirname, '..', '.dockerignore');
const notice = path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md');

/**
 * One authored FFmpeg notice owns attribution, full license texts, and source pointers.
 * Docker gates presence; this suite owns content. Do not restore per-component inventory.
 */

const PLACEHOLDER_TOKENS = ['<year>', '<owner>', '<copyright holders>', '[Owner Organization]'];

describe('ffmpeg license-notice shipping gate (Dockerfile)', () => {
  const df = fs.readFileSync(dockerfile, 'utf-8');

  it('.dockerignore keeps THIRD_PARTY_NOTICES.md in the build context', () => {
    const di = fs.readFileSync(dockerignore, 'utf-8');
    expect(di).toContain('!THIRD_PARTY_NOTICES.md');
  });

  it('COPYs the notice and the project LICENSE into the runner image', () => {
    expect(df).toContain('COPY THIRD_PARTY_NOTICES.md LICENSE ./');
  });

  it('gates on both files being present and non-empty (test -s, not test -r)', () => {
    expect(df).toContain('test -s /app/THIRD_PARTY_NOTICES.md');
    expect(df).toContain('test -s /app/LICENSE');
    expect(df).not.toContain('test -r /app/THIRD_PARTY_NOTICES.md');
  });

  it('installs the tag writer runtime alongside ffmpeg (#2210)', () => {
    // A missing interpreter turns tag embedding into a 503, so packaging is the gate.
    expect(df).toMatch(/apk add --no-cache [^\n]*\bpython3\b/);
    expect(df).toMatch(/apk add --no-cache [^\n]*\bpy3-mutagen\b/);
    expect(df).toMatch(/apk add --no-cache [^\n]*\bffmpeg\b/);
  });
});

describe('THIRD_PARTY_NOTICES.md content', () => {
  const content = fs.readFileSync(notice, 'utf-8');

  it('attributes FFmpeg with upstream link', () => {
    expect(content).toContain('This image bundles FFmpeg');
    expect(content).toContain('ffmpeg.org');
  });

  it('attributes mutagen and Python with upstream links and Alpine provenance (#2210)', () => {
    expect(content).toContain('This image bundles mutagen');
    expect(content).toContain('mutagen.readthedocs.io');
    expect(content).toContain('py3-mutagen');
    expect(content).toContain('GPL-2.0-or-later');
    expect(content).toContain('PSF License Agreement');
    expect(content).toContain('docs.python.org');
  });

  it('states the arm’s-length posture for mutagen, not just FFmpeg', () => {
    expect(content).toMatch(/FFmpeg and mutagen are each invoked as a \*\*separate command-line\s+process\*\*/);
    expect(content).toMatch(/Narratorr is not linked against either/);
  });

  it('points at mutagen corresponding source alongside FFmpeg', () => {
    expect(content).toContain('community/py3-mutagen');
    expect(content).toContain('github.com/quodlibet/mutagen');
  });

  it('reproduces both FFmpeg license texts in full', () => {
    expect(content).toContain('GNU GENERAL PUBLIC LICENSE, Version 2');
    expect(content).toContain('GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1');
    // Full texts, not just headings: each body ends with this marker.
    expect(content.match(/END OF TERMS AND CONDITIONS/g)).toHaveLength(2);
  });

  it('contains real license texts, not SPDX placeholder templates', () => {
    for (const token of PLACEHOLDER_TOKENS) {
      expect(content, `notice must not contain placeholder "${token}"`).not.toContain(token);
    }
  });

  it('is version-agnostic — no ffmpeg version-release pin to go stale', () => {
    // Reject Alpine's version-release form so package revisions cannot stale the notice.
    expect(content).not.toContain('Recorded version-release');
    expect(content).not.toMatch(/\b\d+\.\d+(\.\d+)?-r\d+\b/);
  });

  it('points at the linked-library inventory instead of enumerating it', () => {
    expect(content).toMatch(/apk list --installed/);
    expect(content).toMatch(/apk info --license/);
    expect(content).toContain('pkgs.alpinelinux.org');
  });

  it('includes a corresponding-source pointer and written offer', () => {
    expect(content).toContain('gitlab.alpinelinux.org/alpine/aports');
    expect(content).toContain('community/ffmpeg');
    expect(content).toMatch(/written offer/i);
    expect(content).toMatch(/three years/i);
  });

  it('acknowledges the base image without claiming to discharge its obligations', () => {
    expect(content).toContain('baseimage-alpine');
    expect(content).toMatch(/not a discharge|no.*whole-image completeness|separate/i);
  });
});
