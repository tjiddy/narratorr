// Missing or unknown tags become dev. Strip characters unsafe in HTTP header
// tokens, then fall back again if sanitization empties the tag.
export function resolveVersionTag(): string {
  const tag = process.env.GIT_TAG;
  if (!tag || tag === 'unknown') return 'dev';
  const sanitized = tag.replace(/[^\w.+-]/g, '');
  return sanitized || 'dev';
}

export function getUserAgent(): string {
  return `Narratorr/${resolveVersionTag()}`;
}
