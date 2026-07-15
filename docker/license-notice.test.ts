import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dockerfile = path.join(__dirname, '..', 'Dockerfile');
const dockerignore = path.join(__dirname, '..', '.dockerignore');
const notice = path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md');

/**
 * Static assertions for the FFmpeg license notice (#1862, simplified 2026-07-15).
 *
 * Posture: ONE authored notice — FFmpeg attribution + its GPL-2.0/LGPL-2.1 texts +
 * pointers (linked libraries via the image's apk database, corresponding source via
 * Alpine aports, base image acknowledged) — deliberately NOT a per-component
 * enumeration (that 43-component gate was retired; see killed #1867 for the rationale).
 * Split of duties: the Dockerfile build gate only proves the files SHIP non-empty;
 * this test owns content sanity. Do not re-add component/marker lists here.
 */

// SPDX placeholder tokens that must never appear — the license texts are real
// downloaded texts, not templates (F1 from the original #1862 review).
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
});

describe('THIRD_PARTY_NOTICES.md content', () => {
  const content = fs.readFileSync(notice, 'utf-8');

  it('attributes FFmpeg with upstream link', () => {
    expect(content).toContain('This image bundles FFmpeg');
    expect(content).toContain('ffmpeg.org');
  });

  it('reproduces both FFmpeg license texts in full', () => {
    expect(content).toContain('GNU GENERAL PUBLIC LICENSE, Version 2');
    expect(content).toContain('GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1');
    // Full texts, not just headings — each text body ends with this marker.
    expect(content.match(/END OF TERMS AND CONDITIONS/g)).toHaveLength(2);
  });

  it('contains real license texts, not SPDX placeholder templates', () => {
    for (const token of PLACEHOLDER_TOKENS) {
      expect(content, `notice must not contain placeholder "${token}"`).not.toContain(token);
    }
  });

  it('is version-agnostic — no ffmpeg version-release pin to go stale', () => {
    // The old notice pinned `ffmpeg-8.0.1-r1` and a Dockerfile gate blocked every
    // Alpine revision bump until the pin was updated. The simplified notice must
    // never regress to that: no "Recorded version-release" phrasing, no Alpine
    // version-release form (e.g. 8.0.1-r1, 8.1-r0) anywhere in the notice.
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
