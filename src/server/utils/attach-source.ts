import { access, constants, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';

export type SourceAdmission = { ok: true } | { ok: false; reason: string };

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** At least one readable regular audio file at any depth.
 *
 * Every `readdir` is guarded, and the guard is the point: an unreadable ROOT and an unreadable
 * SUBDIRECTORY beneath a readable root both have to classify as inadmissible rather than throw a
 * raw `EACCES` out to a 500. `containsAudioFiles` recurses unguarded, which is why this does not
 * call it. */
async function hasReadableAudio(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    const child = join(dir, entry.name);
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      if (await isReadable(child)) return true;
      continue;
    }
    if (entry.isDirectory() && await hasReadableAudio(child)) return true;
  }
  return false;
}

/**
 * #2435 AC16 — is this path something the book-scoped attach can import?
 *
 * Stated as a CLOSED POSITIVE rule, deliberately. Enumerating invalid classes missed one in each of
 * two successive spec reviews (readability, then non-file/non-directory nodes) because the set of
 * things a path can be is open-ended while the set of things this action can import is not. A FIFO,
 * socket, device node, broken symlink, unreadable node, hidden root, wrong-extension file or
 * audio-empty directory is refused by construction, with no class list to keep complete.
 *
 * `stat` follows symlinks on purpose, so an operator-created symlink into their media stays legal.
 *
 * Deliberately NOT `validateSource`: that implements four of these conditions, misses readability
 * and node kind, and carries download-client path-mapping parameters this surface has no use for.
 * Changing what the download path accepts is out of scope.
 */
export async function admitAttachSource(sourcePath: string): Promise<SourceAdmission> {
  let stats;
  try {
    stats = await stat(sourcePath);
  } catch {
    return { ok: false, reason: 'Source path does not exist or could not be read' };
  }

  if (isHiddenName(basename(sourcePath))) {
    return { ok: false, reason: 'Source path is hidden (leading dot) and cannot be imported' };
  }

  if (stats.isFile()) {
    if (!AUDIO_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
      return { ok: false, reason: 'Source file is not a supported audio format' };
    }
    if (!(await isReadable(sourcePath))) {
      return { ok: false, reason: 'Source file is not readable' };
    }
    return { ok: true };
  }

  if (stats.isDirectory()) {
    if (!(await isReadable(sourcePath))) {
      return { ok: false, reason: 'Source directory is not readable' };
    }
    if (!(await hasReadableAudio(sourcePath))) {
      return { ok: false, reason: 'Source directory contains no readable supported audio files' };
    }
    return { ok: true };
  }

  return { ok: false, reason: 'Source path is neither a regular file nor a directory' };
}
