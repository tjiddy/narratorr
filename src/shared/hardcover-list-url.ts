// Pure parser for Hardcover public-list URLs — the single source of truth for
// URL validity + extraction, shared by BOTH the client settings UI (inline
// validation, #1879 AC13), the shared Zod schema (`hardcoverSettingsSchema`),
// and the core provider (`fetchCustomList`). It lives in `src/shared/**` because
// `eslint.config.js` forbids every production import from `src/shared/**` into
// `src/core/**`; a shared leaf is importable by client, shared, and core alike.
//
// Canonical form: `https://hardcover.app/@{username}/lists/{slug}`. We accept
// `http`/`https` (or a bare host), an optional `www.`, an optional trailing
// slash, a trailing query/hash, and tolerate the leading `@` on the username.

const HARDCOVER_LIST_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?hardcover\.app\/@?([^/@?#]+)\/lists\/([^/?#]+)\/?(?:[?#].*)?$/i;

export function parseHardcoverListUrl(input: string): { username: string; slug: string } | null {
  const match = HARDCOVER_LIST_URL_RE.exec(input.trim());
  if (!match) return null;
  const [, username, slug] = match;
  if (!username || !slug) return null;
  return { username, slug };
}
