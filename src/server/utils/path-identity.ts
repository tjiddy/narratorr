import { normalize, resolve } from 'node:path';
import { and, isNotNull, ne } from 'drizzle-orm';
import type { DbOrTx } from '@db/index.js';
import { books } from '@db/schema.js';

/**
 * The one definition of "these two strings name the same folder". Every decision about path
 * identity routes through it: the rename ownership fence, the destroyers' owner check, and the
 * claim lock key (`claim-lock.ts`) — ownership identity and lock identity must be the same
 * function, or two operations the fence says contend can enter separate critical sections.
 *
 * The backslash fold happens BEFORE `resolve` and the order is load-bearing: `resolve` treats `\`
 * as an ordinary character on POSIX, so resolving `/library\A\..\Y` first leaves the `..`
 * unresolved while folding first yields `/library/Y`. This is the order `computeFolderTarget`
 * already uses on the stored side (`rename-target.ts`). The second fold is applied after `resolve`
 * only so the output is platform-stable in messages and log lines.
 *
 * Deliberately lexical plus `resolve`: it does not fold case, so on a case-insensitive filesystem
 * `/library/Y` and `/library/y` still read as two claims. Pre-existing and equally true of every
 * other `books.path` consumer; folding case correctly needs the mount's collation.
 *
 * A relative stored value resolves against the process cwd — identically for both sides within one
 * evaluation, so the comparison stays self-consistent.
 */
export function canonicalPath(p: string): string {
  return normalize(resolve(p.split('\\').join('/'))).split('\\').join('/');
}

export interface PathOwner {
  id: number;
  title: string;
}

/**
 * The row — other than `exceptBookId` — whose `books.path` names `folderPath`, or null.
 *
 * Canonicalises every candidate rather than trusting how it was stored: `eq(books.path, …)` is
 * sound only if every stored value is already canonical, and pointer/adopt persists whatever
 * passed `z.string().trim().min(1)` verbatim. `.`/`..` segments are beyond SQL string surgery, so
 * the comparison happens here. Cost is one column read across the book table per call; at
 * self-hosted scale that is microseconds against an operation about to move a folder.
 *
 * Lowest id wins when a pre-existing duplicate-path pair produces two matches, so the conflict
 * message is deterministic across runs.
 */
export async function findOtherPathOwner(
  db: DbOrTx,
  folderPath: string,
  exceptBookId?: number,
): Promise<PathOwner | null> {
  const target = canonicalPath(folderPath);
  const rows = await db
    .select({ id: books.id, title: books.title, path: books.path })
    .from(books)
    .where(exceptBookId === undefined ? isNotNull(books.path) : and(isNotNull(books.path), ne(books.id, exceptBookId)));

  let owner: PathOwner | null = null;
  for (const row of rows) {
    if (row.path == null || canonicalPath(row.path) !== target) continue;
    if (owner === null || row.id < owner.id) owner = { id: row.id, title: row.title };
  }
  return owner;
}
