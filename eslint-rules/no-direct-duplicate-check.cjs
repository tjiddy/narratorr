/**
 * Keeps the duplicate/recording decision in `src/server/services/book-intake`.
 *
 * Flags calls to `findDuplicate`, `create` and `createResolved` that resolve to a method DECLARED
 * ON `BookService`, outside the allowlist. The test is on the called method's declaration, not on
 * the receiver's declared type: the repository injects these through mapped `Pick<BookService, …>`
 * deps as often as through a direct `BookService`, and a rule comparing the receiver type to the
 * class would report nothing on the mapped shape. TypeScript copies the original member's
 * declarations onto a homomorphic mapped type's property, so both shapes — plus a nested
 * `deps.bookService.` and an aliased `const svc = deps.bookService` — resolve identically, while
 * `EventHistory.create` and a generic `service.create(data)` resolve to their own declarations.
 *
 * The method-name filter is load-bearing on its own: `getById` is also declared on `BookService`,
 * is unguarded, and appears on four production `Pick<…>` declarations.
 *
 * This rule inspects CALLS ONLY. A `Pick<BookService, 'findDuplicate'>` type annotation is not a
 * call and must not report. Import-level enforcement is owned by core `no-restricted-imports` in
 * eslint.config.js; there is no import logic here.
 */

const ts = require('typescript');

const GUARDED_METHODS = new Set(['findDuplicate', 'create', 'createResolved']);
const OWNER_CLASS = 'BookService';

/**
 * Five exemption patterns: the four sanctioned production paths plus every test file. The sites
 * ported by #2235, #2243 and #2246 are deliberately absent, and neither `series-add-all.service.ts`
 * nor `import-list.service.ts` needs an entry — both hold a `BookService`/`Pick<BookService, …>`
 * and forward the object to `addBook` without calling a guarded method on it.
 */
const EXEMPT_PATTERNS = [
  { kind: 'dir', path: 'src/server/services/book-intake' },
  { kind: 'file', path: 'src/server/services/book.service.ts' },
  { kind: 'file', path: 'src/server/services/import-submission-runner.ts' },
  { kind: 'file', path: 'src/server/routes/v1/books.ts' },
  { kind: 'suffix', path: '.test.ts' },
];

/** Windows hands ESLint backslash-separated paths; fold them before matching. */
function isExempt(filename) {
  const normalized = String(filename || '').split('\\').join('/');
  return EXEMPT_PATTERNS.some(({ kind, path }) => {
    if (kind === 'dir') return normalized.includes(`${path}/`);
    if (kind === 'suffix') return normalized.endsWith(path);
    return normalized.endsWith(path);
  });
}

/**
 * Resolves the called member's symbol through the parser services. `node` is a TSESTree node, so
 * it must be mapped to its TypeScript counterpart before the checker will accept it.
 *
 * Returns false when the symbol cannot be resolved: within this rule's `src/server/**` scope every
 * file is in the TS program, so an unresolvable symbol means the rule is mis-wired rather than that
 * a violation is present, and reporting then would fire indiscriminately. The RuleTester suite
 * guards that case instead, by asserting invalid cases actually report.
 */
function declaredOnBookService(services, propertyNode) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(propertyNode);
  if (!tsNode) return false;
  const symbol = services.program.getTypeChecker().getSymbolAtLocation(tsNode);
  if (!symbol || !symbol.declarations) return false;
  return symbol.declarations.some((declaration) => {
    const parent = declaration.parent;
    return (
      parent
      && (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent))
      && parent.name
      && parent.name.text === OWNER_CLASS
    );
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require the duplicate/recording decision to go through src/server/services/book-intake. Flags `findDuplicate`/`create`/`createResolved` calls resolving to a `BookService` method outside the allowlist.',
    },
    schema: [],
    messages: {
      directDuplicateCheck:
        "`BookService.{{method}}` is called directly here. The duplicate/recording decision must be built once, in `src/server/services/book-intake` — six independent copies of it drifted and shipped #2199. Call `decideIntake` instead, or add this path to the rule's allowlist if it is a sanctioned owner.",
    },
  },

  create(context) {
    if (isExempt(context.filename)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const property = callee.property;
        if (property.type !== 'Identifier' || !GUARDED_METHODS.has(property.name)) return;

        const services = context.sourceCode.parserServices;
        if (!services || !services.program || !services.esTreeNodeToTSNodeMap) return;
        if (!declaredOnBookService(services, property)) return;

        context.report({ node, messageId: 'directDuplicateCheck', data: { method: property.name } });
      },
    };
  },
};

module.exports = rule;
