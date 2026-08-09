// Accept http(s) or bare Hardcover list URLs, with optional www, @, trailing slash,
// query, or fragment.

const HARDCOVER_LIST_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?hardcover\.app\/@?([^/@?#]+)\/lists\/([^/?#]+)\/?(?:[?#].*)?$/i;

export function parseHardcoverListUrl(input: string): { username: string; slug: string } | null {
  const match = HARDCOVER_LIST_URL_RE.exec(input.trim());
  if (!match) return null;
  const [, username, slug] = match;
  if (!username || !slug) return null;
  return { username, slug };
}
