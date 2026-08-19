/**
 * `.mp4` is here because ABB routinely serves audiobooks as bare `.mp4` — AAC in an MP4 container,
 * byte-format-identical to `.m4b` (#2495). Accepted tradeoff: a *video* `.mp4` is now admissible on
 * the same terms as every other member. That is safe because codec enrichment reads `-select_streams
 * a:0` (audio-probe.ts), never the video stream, and it beats every ABB mp4 dead-ending in review.
 *
 * Renaming imported `.mp4` to `.m4b` was considered and declined: it cannot be applied uniformly.
 * Pointer-mode manual import records the operator's path unchanged, so a rename would land only on
 * the copy/move paths and produce a library where byte-identical books are unpredictably `.m4b` or
 * `.mp4` — worse than a uniform `.mp4`. The cost is real and named: Jellyfin does not recognize an
 * audio-only `.mp4` as music and asks for a rename. An opt-in normalize-on-import setting is the
 * separate fix.
 *
 * Three extension-keyed maps are NOT derived from this set and must be updated alongside it:
 * `AUDIO_MIME_MAP` (audio-preview-stream.ts, exhaustive against this set),
 * `FORMAT_BY_EXTENSION` (mutagen-tag-payload.ts, a deliberate subset), and
 * `MP4_FAMILY_EXTENSIONS` (encode-strategy.ts, a deliberate codec-family subset).
 */
export const AUDIO_EXTENSIONS = new Set([
  '.m4b', '.mp3', '.m4a', '.mp4', '.flac', '.ogg', '.opus', '.wma', '.aac', '.wav',
]);

/** Basename-only; keep import-free for the Vite-facing barrel and aligned with Audiobookshelf's dot-path rule. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}
