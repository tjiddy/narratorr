// Invalid URLs, including masked secret sentinels, fall back instead of being
// echoed in card subtitles.
export function extractHostname(url: string, fallback: string): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
}
