/**
 * Renders a driver query error as a short, param-free operator summary (#2604).
 *
 * `DrizzleQueryError.message` is `Failed query: <sql>\nparams: <bound values>`, and the params line
 * carries `download_url` verbatim — which for MAM grabs is a `data:` torrent URI whose decoded
 * announce URL contains the operator's tracker passkey. This module is the half of the fix that
 * both text chokepoints (`getErrorMessage`, `serializeError`) route through.
 *
 * ZERO IMPORTS BY CONTRACT. `src/client/lib/error-message.ts` re-exports `@shared/error-message.js`,
 * so anything reachable from here lands in the Vite client bundle; independently `src/shared/**` may
 * not import `core/`/`server/` (eslint.config.js). The drizzle class is therefore duck-typed on its
 * measured own-property signature (`query`, `params`, `cause`) rather than imported.
 */

/** Mirrors `serializeError`'s bound: `Error.cause` graphs can be cyclic or arbitrarily deep. */
const MAX_CAUSE_DEPTH = 5;

/** The chain join token. Neutralized inside each link so a cause message cannot forge an entry. */
const CAUSE_JOIN = ' | ';

/** Long enough for `UNIQUE constraint failed: <table>.<col>`, short enough to fit a toast. */
const MAX_SUMMARY_LENGTH = 300;

/** Bounds every regex scan; the leading clause is always at the front of the statement. */
const MAX_QUERY_SCAN = 4096;

const UNKNOWN = 'unknown';

/**
 * Returns an operator-safe summary for a drizzle query error, or `null` for anything else.
 *
 * Total by contract: it is called from inside other people's failure handling, so any internal
 * fault returns `null` and leaves the caller's existing behaviour intact rather than replacing the
 * original error with an error-handler error.
 */
export function describeDbError(error: unknown): string | null {
  try {
    const query = ownDataValue(error, 'query');
    const params = ownDataValue(error, 'params');
    if (typeof query !== 'string' || !Array.isArray(params)) return null;

    const { operation, table } = parseTarget(query);
    const causeText = flattenCauseChain(error);
    const location = `Database ${operation} on ${table} failed`;
    const summary = causeText ? `${location}: ${causeText}` : location;
    return summary.length > MAX_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : summary;
  } catch {
    return null;
  }
}

/**
 * Own DATA properties only. A plain `error.query` read would accept a prototype-inherited value as
 * an own signature and, worse, would invoke an accessor — a throwing getter would make this
 * function (and therefore `getErrorMessage`) throw while handling someone else's failure.
 */
function ownDataValue(error: unknown, key: string): unknown {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  const desc = Object.getOwnPropertyDescriptor(error, key);
  if (!desc || !('value' in desc)) return undefined;
  return desc.value;
}

function parseTarget(query: string): { operation: string; table: string } {
  const head = query.slice(0, MAX_QUERY_SCAN);
  const opMatch = /^\s*(insert|update|delete|select)\b/i.exec(head);
  if (!opMatch) return { operation: UNKNOWN, table: UNKNOWN };
  const operation = opMatch[1]!.toLowerCase();
  return { operation, table: matchTable(operation, head) ?? UNKNOWN };
}

// Identifier characters only: the summary names the target, it never embeds the SQL body.
function matchTable(operation: string, head: string): string | null {
  const pattern =
    operation === 'insert'
      ? /\binto\s+"?([A-Za-z0-9_]+)"?/i
      : operation === 'update'
        ? /^\s*update\s+"?([A-Za-z0-9_]+)"?/i
        : /\bfrom\s+"?([A-Za-z0-9_]+)"?/i;
  const match = pattern.exec(head);
  return match ? match[1]! : null;
}

/**
 * Walks `cause` to the same bounds `serializeError` uses — depth 5 plus an identity set — so a
 * self-referential or mutually cyclic graph truncates instead of looping. A link that cannot be
 * read is skipped rather than fatal: the whole point is to keep the caller off the raw message.
 */
function flattenCauseChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>([error]);
  let current = ownDataValue(error, 'cause');

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const text = readMessage(current);
    if (text) parts.push(text);
    current = ownDataValue(current, 'cause');
  }

  return parts.join(CAUSE_JOIN);
}

function readMessage(value: unknown): string {
  try {
    const raw = value instanceof Error ? value.message : String(value);
    // Collapse newlines and neutralize the join token so a link cannot forge a chain boundary.
    return raw.replace(/\s+/g, ' ').split('|').join('/').trim();
  } catch {
    return '';
  }
}
