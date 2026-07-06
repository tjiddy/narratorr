/**
 * Pure helpers for reasoning about an ffmpeg/ffprobe version string.
 *
 * The CI smoke step (`.github/workflows/docker.yml`) guards the runner image
 * against an ffmpeg < 8 regression (xHE-AAC / USAC decode depends on ffmpeg 8 —
 * #1667 / #1679). Keeping the major-version extraction here as a pure function
 * lets the comparison logic be unit-tested without spawning a binary, and mirrors
 * the numeric (not substring) parse the bash smoke assertion performs.
 */

/**
 * Extract the numeric major version from an ffmpeg/ffprobe version string.
 *
 * Handles the canonical `8.0.1` shape returned by `probeFfmpeg`'s regex, the
 * `n8.0` / `v8.0` prefixed shapes some builds emit, and a trailing distro suffix
 * (`6.1.1-3ubuntu5`). Returns null when no version-like `major.` token leads the
 * string — e.g. the `probeFfmpeg` fallback that returns a custom build's trimmed
 * first line, from which a major cannot be reliably derived.
 */
export function extractFfmpegMajor(version: string): number | null {
  const match = version.trim().match(/^\D*(\d+)\./);
  return match ? Number(match[1]) : null;
}

/**
 * True when the version string's major is a parseable integer >= `min`.
 * An unparseable version (null major) is treated as a failure — the guard must
 * not pass on an indeterminate version.
 */
export function ffmpegMajorAtLeast(version: string, min: number): boolean {
  const major = extractFfmpegMajor(version);
  return major !== null && major >= min;
}
