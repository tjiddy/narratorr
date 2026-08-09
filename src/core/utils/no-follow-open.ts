import { constants } from 'node:fs';

/**
 * Prevents a companion-ebook pathname from being swapped to an outside symlink between
 * containment validation and `open`; both serving and EPUB archive reads must use it.
 * Windows lacks `O_NOFOLLOW`, so `?? 0` deliberately degrades to `O_RDONLY`; Docker/Linux
 * retains the guard. Hard links remain out of scope.
 */
export const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
