/**
 * The characters this codebase treats as apostrophes — U+0027 plus the two curly forms, exactly.
 * Single home: the server-side query folds (`indexer-query.ts`) and ABB's core-side token drop
 * (`abb-query.ts`) must agree on this set, or a title one fold fixes stays unfindable through the
 * other (#2422). Wider lookalikes (U+02BC, U+FF07) are deliberately excluded everywhere.
 *
 * Exported as character sets, not shared RegExp instances — a shared global regex carries a
 * mutable lastIndex; consumers build their own at module scope.
 */
export const CURLY_APOSTROPHE_CHARS = '‘’';
export const APOSTROPHE_CHARS = `'${CURLY_APOSTROPHE_CHARS}`;
