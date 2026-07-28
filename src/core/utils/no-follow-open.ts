import { constants } from 'node:fs';

/**
 * Read-only open flags that refuse to traverse a symlink at the final component.
 *
 * **Why this exists.** Every companion-ebook read verifies containment against a *pathname*
 * (`resolveCompanionEbookPath` → `lstat` → regular-file → realpath inside the library root) and
 * then opens that pathname a moment later. Between those two steps an attacker who can write
 * into the book's folder can replace the file with a symlink; a plain `open()` follows it, and
 * the post-open `fstat` reads only `size`. The library root sits next to `<config>/secret.key`
 * (`secret-codec.ts:368`), so the swap turns a download into key exfiltration.
 *
 * `O_NOFOLLOW` closes that window at the syscall: if the final component became a symlink, the
 * open fails `ELOOP` instead of succeeding on the target. `classifyFailure` already maps that to
 * `unreadable` — no new outcome, no dev/ino binding, no serve-time fingerprint. It is the cheap
 * mitigation that the #1974 declined-alternatives list missed while (correctly) rejecting the
 * expensive ones.
 *
 * **Both companion open sites must use this** — the serve path that streams bytes, and the
 * archive reader inside `core/epub`. If either drifts back to a following open, that path is
 * exploitable on its own. (Named indirectly on purpose: the archive reader's own suite asserts
 * that nothing outside its folder so much as mentions it by filename.)
 *
 * **Windows has no `O_NOFOLLOW`** — `fs.constants.O_NOFOLLOW` is `undefined` there, and a bitwise
 * OR with `undefined` yields `NaN`, which would break every open. The `?? 0` degrades to a plain
 * read-only open. Production runs Linux in Docker, so the protection holds where it matters; a
 * Windows dev box simply loses it.
 *
 * Not covered, deliberately: a **hard link** is not a symlink, so it passes both this flag and
 * realpath containment. Hard links cannot cross filesystems, and `<config>` is a separate mount
 * in the standard deployment. dev/ino binding would not have caught that case either.
 */
export const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
