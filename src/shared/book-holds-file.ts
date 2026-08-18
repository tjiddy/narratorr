/** The single home of "does this book hold a file?".
 *
 * `books.path` reaches this from three layers with three different empty spellings — NULL from the
 * DB, `''` from a cleared form field, and whitespace from a hand-edited settings value — so the
 * trim is part of the predicate rather than each caller's problem. Client, server and core all
 * import it; `src/shared` is the only layer all three may reach. */
export function bookHoldsFile(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.trim().length > 0;
}
