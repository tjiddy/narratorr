/**
 * ESLint rule: no-unstamped-match-generation
 *
 * Every write that installs, replaces or clears `ImportRow.matchResult` must route through
 * `stampRow`, so the row carries a fresh `matchGeneration` (#2055 B7 / #2060). Under-stamping
 * promotes a row whose match evidence was rebuilt underneath an in-flight chapter-corroboration
 * request; the generation token is the only thing that can tell the two apart.
 *
 * `readonly` on the two fields (#2060) blocks direct MUTATION of an existing row. This rule
 * closes the other half — the CONSTRUCTION bypass, where a fresh row literal (or a
 * `mergeMatchIntoRow` result) carrying a match is handed onward without ever passing through
 * `stampRow`.
 *
 * What it reports — a producer of a row value carrying an installed/replaced/cleared match,
 * unless that producer reaches `arguments[0]` of a trusted `stampRow` call:
 *
 *   P1  an `ObjectExpression` with an own `matchResult` key, in any spelling: plain,
 *       shorthand, string-literal, or computed-constant. The property's VALUE is never
 *       inspected, so `matchResult: undefined` is a producer exactly like an install.
 *   P2  a `CallExpression` on the trusted `mergeMatchIntoRow` binding — both of its return
 *       paths install `matchResult`, so its result is always a freshly-installed match.
 *
 * Anchoring is on that PROPERTY, never on `setRows` and never on an enumeration of container
 * shapes. Both proxies were escaped during #2060's review: the live scan site builds its rows
 * in a `map` well outside any `setRows` call, and each round of container-syntax enumeration
 * turned up another shape it had missed.
 *
 * Trust is resolved to a canonical BINDING through the scope chain, never to a spelling — an
 * alias is trusted, a local shadow and a same-named import from another module are not. (The
 * scope-walking precedent in this repo is `no-raw-error-logging.cjs`.)
 *
 * Deliberately OUT of scope:
 *
 *   - **Mutation-based writes.** The rule sees construction sites only. A structurally-
 *     compatible mutable alias has no `matchResult` key at its own construction site — and
 *     TypeScript ignores `readonly` in assignability — so no syntactic rule can see it, nor
 *     can it see `Object.defineProperty` / `Reflect.set`. Those forms remain open and unowned.
 *   - **Full B11 locality.** `stampRow`'s generation must be allocated OUTSIDE the React
 *     updater, because StrictMode double-invokes updaters. That condition is narrowed here to
 *     a syntactic argument-shape check: arg-1 must be a plain `Identifier`. Every syntactic
 *     proxy for the actual locality condition was escaped during #2060's review (a predeclared
 *     updater function, a second setter alias), so the full condition stays documented in
 *     `stampRow`'s JSDoc and pinned at runtime by the over-stamp regression in both hook
 *     suites ("keeps a held response live across an unrelated selection toggle").
 *   - **The converse** (an unrelated write must not stamp) is undecidable syntactically — the
 *     two scan sites legitimately stamp while never mentioning `matchResult`.
 *
 * The rule deliberately errs toward REPORTING: a false positive costs one suppression, a false
 * negative costs a silently-dropped corroboration. For a legitimate shape the rule cannot see,
 * the sanctioned remedy is `// eslint-disable-next-line narratorr/no-unstamped-match-generation`
 * plus a comment justifying why that row is stamped (or need not be).
 */

const TRACKED_KEY = 'matchResult';

/**
 * The trusted OUTPUTS, each keyed to the trust ROOT that resolves it. `mergeMatchIntoRow`
 * arrives via the BARREL — neither hook imports `./mergeMatchIntoRow.js` directly, so a
 * same-named import from that module is a different binding and not a P2 producer.
 */
const TRUSTED_STAMP = { imported: 'stampRow', module: '@/lib/repick-corroboration.js' };
const TRUSTED_MERGE = { imported: 'mergeMatchIntoRow', module: '@/components/manual-import' };

/**
 * Producer files, exempt by basename. `applyCorroboration` is the deliberate terminal
 * unstamped write for the generation it answers, and `mergeMatchIntoRow` is itself the
 * sanctioned merge producer — widening this rule's registration later must not red either.
 */
const PRODUCER_FILES = new Set(['repick-corroboration.ts', 'mergeMatchIntoRow.ts']);

/**
 * The closed set of ascent steps that keep a producer's value on the path to arg-0. Each
 * predicate admits only the positions whose value FLOWS to the wrapper's result — a
 * `ConditionalExpression` test, for instance, is not one of them.
 *
 * Parentheses need no entry: the typescript-eslint parser erases them.
 */
const WRAPPER_STEPS = {
  LogicalExpression: (child, parent) => child === parent.left || child === parent.right,
  ConditionalExpression: (child, parent) => child === parent.consequent || child === parent.alternate,
  TSAsExpression: (child, parent) => child === parent.expression,
  TSSatisfiesExpression: (child, parent) => child === parent.expression,
  TSNonNullExpression: (child, parent) => child === parent.expression,
};

function basenameOf(filePath) {
  const normalized = (filePath || '').replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * The own-key name a property contributes to its object literal, or null when the key is not
 * a statically-known string (`[k]: v`, numeric keys). Covers plain, shorthand, string-literal
 * and computed-constant spellings; `SpreadElement` entries contribute no own key.
 */
function ownKeyName(property) {
  if (property.type !== 'Property') return null;
  const { key, computed } = property;
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : null;
  return null;
}

function installsMatchResult(objectExpression) {
  return objectExpression.properties.some((p) => ownKeyName(p) === TRACKED_KEY);
}

/**
 * The import this identifier resolves to through the scope chain, or null when it resolves to
 * anything else (a local declaration, a parameter, an unresolved global).
 */
function importBindingOf(identifierNode, context) {
  let scope = context.sourceCode.getScope(identifierNode);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifierNode.name);
    if (variable) {
      const def = variable.defs[0];
      if (!def || def.type !== 'ImportBinding' || def.node.type !== 'ImportSpecifier') return null;
      const imported = def.node.imported;
      const declaration = def.parent;
      if (!imported || imported.type !== 'Identifier' || !declaration || !declaration.source) return null;
      return { imported: imported.name, module: declaration.source.value };
    }
    scope = scope.upper;
  }
  return null;
}

function isTrustedCallee(calleeNode, trusted, context) {
  if (!calleeNode || calleeNode.type !== 'Identifier') return false;
  const binding = importBindingOf(calleeNode, context);
  return binding !== null && binding.imported === trusted.imported && binding.module === trusted.module;
}

/**
 * Walk UP from a producer, admitting only the steps in AC2's closed set, and answer whether
 * the walk lands on `arguments[0]` of a trusted `stampRow` call.
 *
 * The one step that may enter an `ObjectExpression` is the spread-hoist, and it is taken as a
 * single indivisible move FROM a spread argument TO the object literal that spread lands in —
 * spreading lifts the inner object's own keys onto the outer literal, so a `matchResult` key
 * genuinely lands on the row the outer literal builds. Expressing it any more loosely ("the
 * parent is an `ObjectExpression`", or a free `Property` step) would also admit a property
 * VALUE, which nests the key one level down instead of installing it on the row.
 */
function isStamped(producer, context) {
  let child = producer;
  let parent = producer.parent;
  while (parent) {
    if (parent.type === 'CallExpression') {
      return parent.arguments[0] === child && isTrustedCallee(parent.callee, TRUSTED_STAMP, context);
    }
    if (parent.type === 'SpreadElement') {
      if (parent.argument !== child) return false;
      // Only a spread INTO an object literal hoists keys; a spread into a call's argument
      // list or an array builds something that is not a row.
      const spreadTarget = parent.parent;
      if (!spreadTarget || spreadTarget.type !== 'ObjectExpression') return false;
      child = spreadTarget;
      parent = spreadTarget.parent;
      continue;
    }
    const step = WRAPPER_STEPS[parent.type];
    if (!step || !step(child, parent)) return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every row construction that installs, replaces or clears `matchResult` to route through `stampRow`, so the row carries a fresh `matchGeneration`. Errs toward reporting: suppress a legitimate shape with `// eslint-disable-next-line narratorr/no-unstamped-match-generation` plus a justifying comment.',
    },
    schema: [],
    messages: {
      unstamped:
        'This builds a row with `matchResult` installed, replaced or cleared without routing through `stampRow`, so the row keeps a stale `matchGeneration` and an in-flight chapter corroboration can promote it on rebuilt evidence (#2055 B7). Wrap it: `stampRow(<this>, generation)`, with `generation` taken from `nextGeneration()` OUTSIDE the updater.',
      generationNotIdentifier:
        "`stampRow`'s second argument must be a plain identifier holding a generation allocated OUTSIDE the `setRows` updater — StrictMode double-invokes updaters, so a stamp computed in there is not the value a concurrent dispatch captured (#2055 B11). Hoist it: `const generation = nextGeneration();` before the `setRows` call.",
    },
  },

  create(context) {
    if (PRODUCER_FILES.has(basenameOf(context.filename))) return {};

    function reportIfUnstamped(node) {
      if (isStamped(node, context)) return;
      context.report({ node, messageId: 'unstamped' });
    }

    return {
      ObjectExpression(node) {
        if (installsMatchResult(node)) reportIfUnstamped(node);
      },

      CallExpression(node) {
        if (isTrustedCallee(node.callee, TRUSTED_STAMP, context)) {
          // An ABSENT second argument is not a plain Identifier either. TypeScript rejects
          // `stampRow(row)` as TS2554 today, but that is redundant coverage rather than a
          // guarantee: give `generation` a default or make it optional and TS goes quiet
          // while the invariant still needs a guard. Anchor the report on the call when
          // there is no argument node to point at.
          const generation = node.arguments[1];
          if (!generation || generation.type !== 'Identifier') {
            context.report({ node: generation ?? node, messageId: 'generationNotIdentifier' });
          }
          return;
        }
        if (isTrustedCallee(node.callee, TRUSTED_MERGE, context)) reportIfUnstamped(node);
      },
    };
  },
};

module.exports = rule;
