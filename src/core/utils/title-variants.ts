/**
 * Shared title-variant generator (#2096).
 *
 * One title, one policy for "which shapes of this title could plausibly name the
 * same book". Pure: no I/O, no clock, no randomness, no server imports. The
 * series member matcher (`src/server/services/series-title-match.ts`) is built on
 * it; `POST /api/series/title-variants-debug` exposes it verbatim.
 *
 * Two axes, and only two:
 *
 *   1. parenthetical / bracket stripping
 *   2. colon-segment selection
 *
 * They are NOT a free cross product (G1). The parens-INTACT string contributes
 * exactly ONE variant — its FULL normalized form. Everything else is derived
 * from the paren-STRIPPED base, because a colon living inside a parenthetical
 * must never shear a segment: a literal cross product over
 * `"The Spiral Path (World of Warcraft: Traveler, Book 2)"` would emit
 * `prefix(1) = "the spiral path world of warcraft"`. `src/shared/dedup.ts`
 * documents the same load-bearing ordering on `buildTitleShape`.
 *
 * Deliberately absent: a `titleBearing` signal (safety lives in the pairwise
 * acceptance rule, not in a per-variant flag) and an article-stripping axis
 * (articles are series-identity scope). Also deliberately absent, and this one
 * is a divergence from `dedup.ts` carrying a named DRY-3 justification: the
 * `TAG_TITLE_SERIES_MARKER_REGEX` volume-marker strip. `dedup.ts` collapses
 * `"Saga Book 1"` onto `"Saga Book 2"` (#1896, a pinned, deliberately-unchanged
 * behaviour there). Propagating it here would make consecutive volumes of a
 * series indistinguishable — which is precisely the population this matcher
 * iterates — so the marker stays.
 */

/**
 * INTERNAL binding — everything this module constructs is typed through these
 * aliases, never through the public names re-exported below. That separation is
 * deliberate and load-bearing for the drift guards in
 * `src/shared/schemas/series-title-variants.test.ts`: if the generator built its
 * result through the PUBLIC `Variant` / `VariantTag` names, any divergence in
 * those names would be caught by this module's own typecheck first, and the
 * guards would never be the failing observation. Aliasing the internal use keeps
 * the public re-export independently mutable, so each guard alone detects drift
 * of its own exported name (verified by mutation — see that test file).
 */
import type {
  Variant as SharedVariant,
  VariantTag as SharedVariantTag,
} from '@shared/schemas/series-title-variants.js';

/**
 * PUBLIC contract surface. The canonical variant contract lives in `src/shared`
 * — `src/shared` may not import `src/core`, so the type goes there and core
 * consumes it, not the reverse. This re-export is the documented consumption
 * path for core-side consumers; server-side consumers take the type straight
 * from shared, which is why the only thing binding these names today is the
 * drift guard that exists to watch them.
 */
export type { Variant, VariantTag } from '@shared/schemas/series-title-variants.js';

/**
 * The colon-boundary threshold, imported from its single home in
 * `src/shared/dedup.ts` (#2109 AC12) rather than re-declared — a core→shared
 * VALUE import, which the layer rules permit (`src/core/**` is restricted from
 * `src/server/**` only) and which this tree already does widely.
 *
 * Here it is the min trimmed length of a segment's LEFT CONTEXT for a `:` to act
 * as a boundary: below it the `:` stays inside its segment as ordinary separator
 * text, so `"IT: Chapter Two"` is one segment, not two.
 *
 * The shared constant unifies the NUMBER and nothing else — the two systems
 * deliberately measure it over different strings and at different scope, and no
 * import can reconcile that:
 *
 *  - `dedup.ts` applies it to the FIRST colon only, measured over
 *    `normalizeTitleCore(title)` output — lowercased, whitespace-collapsed and
 *    trailing-suffix-stripped before the colon is even located
 *    (`buildTitleShape`).
 *  - here it applies at EVERY colon (G3), measured over the RAW paren-stripped
 *    segment text, before any normalization runs.
 *
 * Same number, different strings, different scope. A third hand-rolled copy
 * lives at `src/server/services/tag-search-planner.ts` as a bare `>= 3` literal;
 * consolidating it is #2102's job, not this import's.
 */
import { COLON_PREFIX_MIN } from '@shared/dedup.js';

/**
 * The generator's input clamp (#2109). Past EITHER cap `titleVariants` skips the
 * colon-segment loop entirely and emits only its FULL forms — see that
 * function's docblock for the degrade rule and why dropping the derived axis is
 * the safe direction.
 *
 * `MAX_VARIANT_TITLE_LENGTH` doubles as the source bound `hardcover.ts` applies
 * to a member title before mapping it, so the two limits cannot drift apart.
 * 2048 characters is roughly 25x the longest real book title; the values exist
 * to bound adversarial or corrupt input, not to make a judgement about titles.
 */
export const MAX_VARIANT_TITLE_LENGTH = 2048;
export const MAX_VARIANT_SEGMENTS = 32;

/**
 * The scalar normalizer, and the SINGLE implementation home for it — a
 * server-homed one would be unreachable from here (`src/core/**` may not import
 * `src/server/**`) and would force a duplicate. `series-title-match.ts`
 * re-exports it as `normalizeMemberTitleForMatch`, so its existing call sites
 * are untouched.
 *
 * Folds curly apostrophes, peels audio-edition tails (`(Unabridged)` /
 * `(Audio)` / `(Audible)`, paren and bracket forms), lowercases, folds combining
 * diacritics (é → e) before the alnum strip so the accented spelling keeps its
 * letter, canonicalizes `&`/`+` to the word "and" so neither spelling drops,
 * then collapses every remaining non-alphanumeric run to a single space.
 *
 * A `:` is therefore a SEPARATOR, not a truncation point: `"Chapterhouse: Dune"`
 * normalizes to `chapterhouse dune`, not `chapterhouse`. The pre-#2096 truncation
 * is what made that member fail to pair with a library `"Chapterhouse Dune"`.
 *
 * The edition strip staying HERE (rather than being left to the derived
 * paren-stripped axis) is load-bearing. Demote it and both sides of
 * `"Foo (Audio)"` ≡ `"Foo (Unabridged)"` reduce to `foo` as DERIVED forms, which
 * the asymmetric acceptance rule forbids from pairing. Keeping it scalar makes
 * both FULL forms `foo`, matching on the FULL≡FULL arm.
 *
 * The generic parenthetical strip is NOT here — that is the derived axis.
 */
export function normalizeTitleForVariantMatch(title: string): string {
  return applyCommonFolds(title, SCALAR_DIACRITIC_STRIP, SCALAR_KEEP_CLASS);
}

/**
 * Every fold step the scalar and lossless pipelines GENUINELY share, in order,
 * with the two steps they differ in passed in (#2109 AC8):
 *
 *   curly apostrophes → audio-edition tails (paren and bracket) → lowercase →
 *   NFD → *diacriticStrip* → `&`/`+` → "and" → *keepClass* → collapse → trim
 *
 * PRIVATE, deliberately: this is internal DRY, not a new contract. Keeping it
 * unexported is what leaves the #2104 AC30 export-freeze test a meaningful
 * signal about the module's public surface.
 *
 * It cannot make the lockstep premise true BY CONSTRUCTION, and no extraction
 * could: the two knobs stay independently editable, and the diacritic BAND
 * asymmetry (`latin-bounded-combining-mark-strip`) is exactly the silent
 * divergence that would follow a one-sided edit. The proof is the property test
 * `asciiFold(normalizeTitleLosslessly(t)) === normalizeTitleForVariantMatch(t)`
 * in `title-variants.test.ts`, which is required IN ADDITION to this extraction,
 * not as an alternative to it.
 */
function applyCommonFolds(
  title: string,
  diacriticStrip: (decomposed: string) => string,
  keepClass: RegExp,
): string {
  const decomposed = title
    .replace(/[’‘]/g, "'")
    .replace(/\(\s*(?:unabridged|audio|audible)\s*\)/gi, ' ')
    .replace(/\[\s*(?:unabridged|audio|audible)\s*\]/gi, ' ')
    .toLowerCase()
    .normalize('NFD');
  return diacriticStrip(decomposed)
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(keepClass, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The two knobs, one pair per pipeline. Both diacritic strips are bounded to
 * U+0300–036F and that agreement is the lockstep premise
 * `hasDegenerateFullForm` rests on — see `normalizeTitleLosslessly` for why the
 * lossless one is additionally bounded to Latin bases, and why neither may be
 * widened to `\p{M}`.
 */
const SCALAR_DIACRITIC_STRIP = (decomposed: string): string => decomposed.replace(/[̀-ͯ]/g, '');
const SCALAR_KEEP_CLASS = /[^a-z0-9' ]+/g;
const LOSSLESS_DIACRITIC_STRIP = (decomposed: string): string =>
  decomposed.replace(/(\p{Script=Latin})[̀-ͯ]+/gu, '$1');
const LOSSLESS_KEEP_CLASS = /[^\p{L}\p{N}\p{M}' ]+/gu;

/**
 * Drop every `(...)` / `[...]` group. Runs on the RAW title, before segmentation.
 *
 * A single left-to-right DEPTH-COUNTING scan, deliberately not a regex. `(` and
 * `[` increment the depth, `)` and `]` decrement it with a floor at 0, and every
 * bracket character plus every character at depth > 0 is emitted as a space.
 * Both delimiter kinds share ONE counter, so `"Foo (Bar] Baz"` closes on the `]`
 * and keeps `Baz`; a kind-aware stack would swallow the rest of the string.
 *
 * The contract the regex form could not honour (#2109):
 *
 *  - **An unterminated group strips to end-of-string.** A missing `)` is an
 *    ordinary truncation artefact in community-edited metadata, and the old
 *    `\([^)]*\)` simply did not match it — so the parenthetical's text and its
 *    COLON stayed in the base and sheared a segment. `"The Spiral Path (World of
 *    Warcraft: Traveler, Book 2"` emitted `prefix(1) = "the spiral path world of
 *    warcraft"`, the exact G1 violation the two-axis rule above exists to forbid.
 *  - **Nested groups strip as one unit.** `[^)]*` closed at the FIRST `)`, so the
 *    inner group's tail leaked out: `"Dune (Deluxe (2nd) Edition: Annotated)"`
 *    left `"Dune Edition: Annotated"` in the base and fabricated
 *    `prefix(1) = "dune edition"`.
 *
 * The scan is also what makes the module linear on adversarial input: `\([^)]*\)`
 * backtracks quadratically over a run of unmatched `(` (80 K chars → ~12 s
 * measured), which the depth counter cannot do.
 *
 * One contiguous stripped RUN contributes exactly ONE space, not one space per
 * character. That is byte-identical to what the regex form emitted for the input
 * it did handle (a balanced group collapsed to a single space), which is what
 * keeps `titleSegments` — documented as returning RAW, unnormalized text — from
 * changing under callers for every well-formed title. Nothing downstream can see
 * the difference either way (the sole production consumer,
 * `search-query-ladder.ts:134`, normalizes each segment immediately, and every
 * variant `raw` is whitespace-collapsed), so the cheaper-to-verify choice is the
 * one that leaves the existing corpus untouched.
 */
function stripParentheticals(title: string): string {
  let depth = 0;
  let out = '';
  let runEmitted = false;
  for (const ch of title) {
    const opener = ch === '(' || ch === '[';
    const closer = ch === ')' || ch === ']';
    if (!opener && !closer && depth === 0) {
      out += ch;
      runEmitted = false;
      continue;
    }
    if (opener) depth++;
    else if (closer && depth > 0) depth--;
    if (!runEmitted) {
      out += ' ';
      runEmitted = true;
    }
  }
  return out;
}

/**
 * Split the paren-stripped base on qualifying colon boundaries (G3). Scans
 * left to right: a `:` closes the pending segment only when that segment's
 * trimmed text already reaches `COLON_PREFIX_MIN`; otherwise the `:` is appended
 * as ordinary text. Segments empty after trimming are dropped, so a leading or
 * trailing colon contributes nothing.
 */
function colonSegments(base: string): string[] {
  const segments: string[] = [];
  let pending = '';
  for (const ch of base) {
    if (ch === ':' && pending.trim().length >= COLON_PREFIX_MIN) {
      segments.push(pending);
      pending = '';
    } else {
      pending += ch;
    }
  }
  segments.push(pending);
  return segments.filter((segment) => segment.trim().length > 0);
}

/**
 * The segment primitive (#2104 D19) — the exact base `titleVariants` derives its
 * `prefix(n)` / `suffix(n)` / `first+last` slices from, exported so a consumer can
 * see the segment BOUNDARIES the generator's space-joined `raw` erases.
 *
 * Purely a composition of the two private folds above; no new logic, and no
 * existing export changes behaviour. It is additive for two reasons the query
 * ladder (#2104) needs and cannot get from `Variant` alone:
 *
 *  1. `raw` joins retained segments with spaces, so a predicate built on it is
 *     either whole-string containment (which false-negatives the book's own
 *     canonical title) or a non-contiguous token walk (which admits
 *     `"Star Wars: Haunted Totally Different Starlight"` against a retained
 *     `Haunted Starlight`). Real segments make per-segment containment possible.
 *  2. `VariantTag` carries the RETAINED `n`, never the segment count, and dedup
 *     makes the emitted tags non-dense — `"---: Alpha: Beta: Gamma: ---"` has 5
 *     segments but tops out at `prefix(3)` because the wider slices all collapse
 *     onto the same text. Neither the count nor its maximum is recoverable.
 *
 * Returns RAW segment text, unnormalized: `colonSegments` keeps any segment with
 * non-whitespace content, including punctuation-only text like `---` that
 * {@link normalizeTitleForVariantMatch} then erases. Consumers that count
 * segments must normalize and drop empties FIRST and count that set — the raw
 * length is not the effective one.
 *
 * Explicitly NOT subject to the `titleVariants` clamp (#2109 AC6). This function
 * is documented as returning the EXACT base slices the generator derives from,
 * and capping it silently would break that contract; it is already linear, so
 * there is nothing to bound. No inconsistency arises from the asymmetry either:
 * once the generator degrades, the ladder's `admitVariants` finds no derived
 * variant to floor and admits only the unfloored `full` forms.
 */
export function titleSegments(title: string): string[] {
  return colonSegments(stripParentheticals(title));
}

/**
 * The LOSSLESS twin of `normalizeTitleForVariantMatch`: identical folds (curly
 * apostrophes, audio-edition tails, case, `&`/`+` → "and", punctuation-to-space,
 * whitespace collapse) except that the character class is Unicode-aware, so
 * letters, digits AND combining marks in every script survive.
 *
 * It exists to answer one question the lossy form cannot: are these two titles
 * actually the same text? It tolerates exactly the drift the scalar form
 * tolerates and nothing more, so using it as identity evidence never accepts a
 * pairing the scalar form would have rejected on those axes.
 *
 * The combining-mark strip is NARROW, and both halves of the bound are
 * load-bearing (#2110):
 *
 *  - **Latin bases only.** Stripping marks script-agnostically is not a
 *    "consistent fold", it is an identity erasure everywhere the mark is not a
 *    drift artefact. Cyrillic `й` decomposes to `и` + breve, so an unqualified
 *    strip pairs `"…: май"` with `"…: маи"` — two different books — through
 *    exactly the degenerate FULL≡FULL arm this form is the sole evidence for.
 *    Same for Devanagari matras, Arabic harakat and Hebrew niqqud, which the
 *    old `[^\p{L}\p{N}' ]` keep class additionally turned into word-fragmenting
 *    spaces (`"किताब"` → `"क त ब"`), producing false pairs AND false refusals.
 *    On a Latin base the strip is unchanged, so `é` → `e` drift tolerance and
 *    every `"Les Misérables"` ≡ `"Les Miserables"` pairing survive.
 *  - **U+0300–036F only, not `\p{M}`.** An implementation that strips every
 *    `\p{M}` after a Latin base passes every in-block fixture while breaking
 *    the lockstep premise `hasDegenerateFullForm` rests on. `"Sa᷀ga: Book One"`
 *    (Latin `a` + U+1DC0) scalar-folds to `"sa ga book one"` — the SCALAR
 *    diacritic step does not reach U+1DC0 either, so the mark falls through to
 *    `[^a-z0-9' ]+` and fragments the word. Keeping it here yields
 *    `"sa᷀ga book one"` and a correct `degenerateFull: true`; stripping it
 *    yields `"saga book one"` and silently trusts a genuinely lossy title. The
 *    band is the contract, not an implementation detail.
 *
 * Optional pointing/vocalization is therefore NOT equivalent to its unpointed
 * spelling, deliberately: "pronunciation aid" vs "identity-bearing vowel" is
 * not decidable from `\p{Mn}`/`\p{Mc}` (Devanagari matras span both, and `ी` is
 * exactly the character that must not fold). A false refusal costs a missing
 * "In Library" badge, which position rescue still covers; a false pair puts a
 * wrong badge on a different book. Same posture the module already takes on
 * `ß`/`ø`/`æ`.
 *
 * `.normalize('NFC')` runs LAST, after the whitespace collapse and trim: the
 * pipeline decomposes to apply the strip, so without recomposing, a title
 * carrying a surviving mark would never equal the same title written in the
 * ordinary composed form.
 */
export function normalizeTitleLosslessly(title: string): string {
  return applyCommonFolds(title, LOSSLESS_DIACRITIC_STRIP, LOSSLESS_KEEP_CLASS).normalize('NFC');
}

/**
 * Did this title lose identity-bearing content to the scalar fold — leaving a
 * FULL form that is not actually the whole title?
 *
 * `normalizeTitleForVariantMatch` is deliberately lossy: `[^a-z0-9' ]+` drops
 * every character outside the ASCII alnum set, and the NFD fold only rescues
 * letters that DECOMPOSE (`é` → `e`; `ß`/`ø`/`æ` stay unfolded, the #1547 scope
 * pin). A title whose distinguishing content is written in another script loses
 * all of it: the live case is `"World of Warcraft: Перед бурей"`, whose FULL
 * form is exactly `world of warcraft`.
 *
 * That breaks the assumption the asymmetric acceptance rule rests on — that a
 * FULL form is the COMPLETE title, so a fragment equal to it must BE that whole
 * title. Here the "complete title" IS a fragment, so it pairs with the
 * `prefix(1)` of every sibling in the franchise. It is the franchise-prefix
 * cross-match class the rule exists to kill, re-entering through the normalizer.
 *
 * Detection is by CHARACTER SURVIVAL, deliberately structure-free: every
 * identity-bearing character the lossless form keeps but the ASCII fold drops is
 * content the FULL form does not represent. Because `normalizeTitleLosslessly`
 * has already reduced the title to letters, digits, apostrophes and single
 * spaces, "dropped by the ASCII fold" is exactly "outside `[a-z0-9' ]`".
 *
 * This guard has been wrong twice, in instructive ways, and the current shape is
 * what survived both:
 *
 *  1. A STRUCTURAL test ("does the title have a qualifying colon boundary whose
 *     tail vanished?") had to name every shape the erased content could take —
 *     after a colon, inside parentheses, inside brackets, or with no colon at all
 *     (`"World of Warcraft (Перед бурей)"`). It missed each shape it had not been
 *     told about.
 *  2. A TOKEN test ("does some whole token normalize to nothing?") missed MIXED
 *     tokens. `"World of Warcraft: A前夜"` and `"World of Warcraft: A後夜"` both
 *     reduce to `world of warcraft a`; each tail is a single token whose scalar
 *     form is the non-empty `a`, so both looked safe and the two different books
 *     matched through FULL≡FULL. The `a` survived; the characters that told the
 *     books apart did not. Partial loss is loss.
 *
 * Characters, not tokens and not structure, are the granularity at which the
 * fold actually discards information — so that is where the question belongs.
 *
 * Non-degenerate by construction, each pinned by a test:
 *  - every character survives — `"Chapterhouse: Dune"`, `"Foundation (1951)"`.
 *  - a diacritic that FOLDS survives — `"Les Misérables"` → `les miserables` is
 *    all-ASCII after the fold, so nothing was discarded.
 *  - an apostrophe survives — `"Hitchhiker's Guide"`.
 *  - nothing survives at all — the empty-variant guard (G5) owns that case, so
 *    an empty FULL form is never reported here.
 *
 * Note that a NON-decomposing Latin letter (`ß`/`ø`/`æ`, the #1547 scope pin) IS
 * degenerate: `"Straße"` scalar-folds to `stra e`, which has genuinely lost the
 * `ß`. An earlier revision of this guard called that "fragmenting, not missing"
 * and let it pass — the same reasoning that let the mixed-token case through.
 * Being degenerate costs such a title very little: it can still offer its
 * fragments to a non-degenerate FULL side, and two records of it still pair
 * through the lossless comparison.
 *
 * Found by the AC17 blast check against the live library (633 books) — exactly
 * the unknown-corpus defect that sweep exists to surface.
 */
export function hasDegenerateFullForm(title: string): boolean {
  const full = normalizeTitleForVariantMatch(title);
  if (full.length === 0) return false;
  return /[^a-z0-9' ]/.test(normalizeTitleLosslessly(title));
}

/**
 * Generate the ordered, deduped variant set for a title.
 *
 * Order is a TOTAL order (G4), most-specific first, so a full-array assertion is
 * meaningful: the parens-intact `full`, then the paren-stripped `full`, then
 * descending retained-segment count — within one count `prefix` before `suffix`,
 * with `first+last` immediately after the pair of the same count (it retains two
 * segments). Dedup keeps the FIRST occurrence of each collapsed key, which is
 * why `prefix(k)`/`suffix(k)` at k === the segment count silently collapse onto
 * the paren-stripped `full` rather than shadowing it.
 *
 * Variants whose normalized text is empty are discarded, so a title carrying no
 * alphanumerics (`'[ ]'`, `'   '`) yields `[]` — never an empty-string entry that
 * could pair with another empty-string entry.
 *
 * **The clamp (#2109).** Past `MAX_VARIANT_TITLE_LENGTH` raw characters, or
 * `MAX_VARIANT_SEGMENTS` colon segments in the paren-stripped base, the derived
 * loop is skipped and only the FULL forms are emitted. Everything else about the
 * function is unchanged: the two FULL pushes and the first-key-wins dedup run
 * exactly as they always do, so a clamped result carries 1 or 2 entries
 * following the ordinary dedup contract — the clamp removes work, it does not
 * add a return shape. The one property it owns is that no `prefix(n)`,
 * `suffix(n)` or `first+last` variant is emitted.
 *
 * Why: the loop slices, joins and normalizes once per segment, each step O(L), so
 * it is O(L²) on colon-dense input — 8 KB measured at ~360 ms, 64 KB at ~27 s of
 * SYNCHRONOUS event-loop blocking. That work runs inside `persistMembers`'
 * transaction, and libSQL serializes every transaction at the single connection,
 * so one corrupt community-edited member title stalls all other writes. Post-
 * clamp the function is O(L) at any length: the depth scan, the normalizers and
 * `hasDegenerateFullForm` are each linear and the quadratic loop is unreachable.
 *
 * The title text is NEVER truncated. Truncation manufactures a sheared fragment
 * that the matcher would then trust as a complete title — exactly what G1
 * forbids, and durable on the bind path. Dropping the derived axis can only ever
 * yield FEWER variants, so its failure mode is a false REFUSAL (a missing "In
 * Library" badge, which position rescue already covers) and never a false pair.
 * Same safety posture the module takes on `ß`/`ø`/`æ`.
 *
 * `titleSegments` is deliberately NOT clamped — see its docblock.
 */
export function titleVariants(title: string): SharedVariant[] {
  const variants: SharedVariant[] = [];
  const seen = new Set<string>();

  // `raw` is already lowercased and whitespace-collapsed, so it IS the
  // case-insensitive collapsed key — no second derivation to drift.
  //
  // `lossy` (#2110) asks `hasDegenerateFullForm`'s question of this SLICE, on
  // the RAW slice text — before normalization, because the whole point is which
  // characters the normalization discarded. The pairing rule refuses a lossy
  // variant as OFFERED evidence: `"World of Warcraft: Тревелер (Traveler)"`
  // must not claim a bare `"World of Warcraft"` through a fragment whose
  // distinguishing content the fold ate, which is #2096's own lesson applied at
  // the variant level rather than only at the full-form level.
  //
  // Dedup keeps the FIRST occurrence's flag, and that is safe in one direction
  // only — which happens to be the right one. A slice cannot drop a character
  // the whole title kept, so `hasDegenerateFullForm(title) === false` implies
  // every slice is non-lossy: "first non-lossy, later lossy" cannot occur. The
  // only real collision is "first lossy, later non-lossy", which retains the
  // lossy flag — conservative, and exactly what kills the Тревелер case (its
  // non-lossy `prefix(1)` collapses onto the earlier lossy entry and is never
  // emitted at all).
  const push = (text: string, tag: SharedVariantTag, parensStripped: boolean): void => {
    const raw = normalizeTitleForVariantMatch(text);
    if (raw.length === 0 || seen.has(raw)) return;
    seen.add(raw);
    variants.push({ raw, tag, parensStripped, lossy: hasDegenerateFullForm(text) });
  };

  push(title, 'full', false);

  const base = stripParentheticals(title);
  push(base, 'full', true);

  // Two separate returns, not one combined predicate: each cap then has its own
  // observation point (T8 / T9), so deleting either check fails a test.
  if (title.length > MAX_VARIANT_TITLE_LENGTH) return variants;

  const segments = colonSegments(base);
  if (segments.length > MAX_VARIANT_SEGMENTS) return variants;

  const last = segments[segments.length - 1];
  for (let n = segments.length; n >= 1; n--) {
    push(segments.slice(0, n).join(' '), `prefix(${n})`, true);
    push(segments.slice(segments.length - n).join(' '), `suffix(${n})`, true);
    // `first+last` retains two segments, so it belongs to the n === 2 group.
    // For a two-segment title it equals the paren-stripped full and is deduped.
    if (n === 2 && last !== undefined) {
      push(`${segments[0]} ${last}`, 'first+last', true);
    }
  }

  return variants;
}
