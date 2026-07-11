import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dockerfile = path.join(__dirname, '..', 'Dockerfile');
const dockerignore = path.join(__dirname, '..', '.dockerignore');
const notice = path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md');

/**
 * Static assertions for the ffmpeg license-notice compliance gate (#1862).
 *
 * These read the Dockerfile / .dockerignore / THIRD_PARTY_NOTICES.md as text — they do
 * NOT build the image. The build-time behaviour (the runner-stage RUN failing the build)
 * is what enforces compliance at publish time; this test guards that the gate is present,
 * complete, and stays in sync with the notice it validates.
 */

// The covered components the build gate greps for (must match the Dockerfile loop AND
// appear in the notice). The full ffmpeg-added linked set — codec + support libraries —
// arch-union across linux/amd64 + linux/arm64 (incl. amd64-only libvpl), with base-image
// libraries (musl, zlib, openssl) subtracted. Copyleft AND permissive.
const COVERED_COMPONENTS = [
  // codec / encode-decode
  'ffmpeg', 'x264', 'x265', 'lame', 'xvidcore', 'aom', 'dav1d', 'libvpx', 'libwebp',
  'libvorbis', 'libtheora', 'opus', 'svt-av1', 'rav1e', 'libjxl', 'libva', 'libvpl', 'shaderc',
  // filter / muxer / protocol / device support
  'libass', 'libbluray', 'libbz2', 'fontconfig', 'freetype', 'fribidi', 'harfbuzz', 'lilv',
  'libopenmpt', 'libplacebo', 'librist', 'soxr', 'libsrt', 'libssh', 'vidstab', 'libxml2',
  'zimg', 'libzmq', 'libdrm', 'libvdpau', 'alsa-lib', 'libpulse', 'v4l-utils', 'libx11', 'libxcb',
];

// Distinct license headings + the FFmpeg attribution the gate greps for.
const LICENSE_MARKERS = [
  'GNU GENERAL PUBLIC LICENSE',
  'GNU LESSER GENERAL PUBLIC LICENSE',
  'GNU LIBRARY GENERAL PUBLIC LICENSE',
  'Mozilla Public License',
  'Apache License',
  'BSD 2-Clause',
  'BSD 3-Clause',
  'The Clear BSD License',
  'MIT License',
  'ISC License',
  'X11 License',
  'bzip2 License',
  'WTFPL',
  'FFmpeg',
];

describe('ffmpeg license-notice build gate (Dockerfile)', () => {
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

  it('gates on the installed ffmpeg version-release matching the notice', () => {
    // Derives the version from `apk info ffmpeg` and greps the notice for it.
    expect(df).toContain('apk info ffmpeg');
    expect(df).toMatch(/grep -q "\$V" \/app\/THIRD_PARTY_NOTICES\.md/);
  });

  it('gates on a marker for every covered component (copyleft AND permissive)', () => {
    // The Dockerfile iterates the component list in a `for c in ... ` loop; assert each
    // covered component name appears in the Dockerfile gate.
    for (const c of COVERED_COMPONENTS) {
      expect(df, `Dockerfile gate should reference component "${c}"`).toContain(c);
    }
  });

  it('gates on every distinct license heading and the FFmpeg attribution', () => {
    for (const m of LICENSE_MARKERS) {
      expect(df, `Dockerfile gate should reference license marker "${m}"`).toContain(m);
    }
  });
});

describe('THIRD_PARTY_NOTICES.md content matches the gate', () => {
  const content = fs.readFileSync(notice, 'utf-8');

  it('is non-empty', () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it('records the ffmpeg version-release the gate pins', () => {
    expect(content).toContain('8.0.1-r1');
  });

  it('mentions every covered component the gate checks', () => {
    for (const c of COVERED_COMPONENTS) {
      expect(content, `notice should mention "${c}"`).toContain(c);
    }
  });

  it('contains every distinct license heading + FFmpeg attribution the gate checks', () => {
    for (const m of LICENSE_MARKERS) {
      expect(content, `notice should contain "${m}"`).toContain(m);
    }
  });

  it('includes the full copyleft license texts (not just headings)', () => {
    expect(content).toContain('END OF TERMS AND CONDITIONS');
    // LGPL 2.1 distinctive clause wording
    expect(content).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
  });

  it('includes a corresponding-source contract for the copyleft set', () => {
    expect(content).toContain('3.23-stable');
    expect(content).toContain('community/ffmpeg');
    expect(content).toContain('main/x265');
    expect(content).toContain('main/lame');
    expect(content).toMatch(/written offer|equivalent access|corresponding source/i);
  });

  it('acknowledges the base image without claiming to discharge its obligations', () => {
    expect(content).toContain('baseimage-alpine:3.23');
    expect(content).toMatch(/not a discharge|no.*whole-image completeness|separate/i);
  });
});
