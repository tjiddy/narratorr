// xHE-AAC/USAC decoding requires ffmpeg 8+, so callers must compare numeric majors.
export function extractFfmpegMajor(version: string): number | null {
  const match = version.trim().match(/^\D*(\d+)\./);
  return match ? Number(match[1]) : null;
}

export function ffmpegMajorAtLeast(version: string, min: number): boolean {
  const major = extractFfmpegMajor(version);
  return major !== null && major >= min;
}
