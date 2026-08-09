import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-unstamped-match-generation.cjs';

// Wire RuleTester into Vitest so each case reports independently.
RuleTester.describe = describe;
RuleTester.it = it;

// Under this pnpm layout only the root `typescript-eslint` parser resolves here.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

const STAMP_IMPORT = "import { stampRow } from '@/lib/repick-corroboration.js';";
const MERGE_IMPORT = "import { mergeMatchIntoRow } from '@/components/manual-import';";

const withTrustRoots = (code) => `${STAMP_IMPORT}\n${MERGE_IMPORT}\n${code}`;

const LIBRARY_HOOK = 'src/client/pages/library-import/useLibraryImport.ts';
const MANUAL_HOOK = 'src/client/pages/manual-import/useManualImport.ts';
const CORROBORATION_FILE = 'src/client/lib/repick-corroboration.ts';
const MERGE_FILE = 'src/client/components/manual-import/mergeMatchIntoRow.ts';

// Pair identical producer source under exempt and hook filenames to isolate basename exemption behavior.
const APPLY_CORROBORATION_WRITE = `
  const next = rows.map((row) => {
    if (row.book.path !== target.path) return row;
    return { ...row, matchResult: promoteMatchToHigh(row.matchResult) };
  });
`;
const MERGE_EARLY_RETURN = `
  function mergeMatchIntoRow(row, match) {
    return { ...row, book, matchResult: match, selected, edited: buildEditedFromBestMatch(match.bestMatch, row.edited) };
  }
`;
const MERGE_TERMINAL_RETURN = `
  function mergeMatchIntoRow(row, match) {
    return { ...row, book, matchResult: match, selected };
  }
`;

ruleTester.run('no-unstamped-match-generation', rule, {
  valid: [
    {
      name: 'library mergeMatchResults',
      filename: LIBRARY_HOOK,
      code: withTrustRoots(`
        setRows(prev => prev.map(row => {
          const match = resultMap.get(row.book.path);
          if (!match) return row;
          if (isLibraryDbDuplicate(row.book)) return row;
          return stampRow(mergeMatchIntoRow(row, match), generation);
        }));
      `),
    },
    {
      name: 'library scan map literal (no matchResult key at all)',
      filename: LIBRARY_HOOK,
      code: withTrustRoots(`
        const newRows = result.discoveries.map((book) => stampRow({
          book,
          selected: !book.isDuplicate,
          userEdited: false,
          edited: {
            title: book.parsedTitle,
            author: book.parsedAuthor || '',
            series: book.parsedSeries || '',
            ...(book.parsedSeriesPosition !== undefined && { seriesPosition: book.parsedSeriesPosition }),
          },
        }, scanGeneration));
        setRows(newRows);
      `),
    },
    {
      name: 'library handleEdit conditional spread (the AC2 spread-hoist positive)',
      filename: LIBRARY_HOOK,
      code: withTrustRoots(`
        setRows(prev => prev.map((r, i) => {
          const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);
          return stampRow({ ...r, book: updatedBook, edited: state, selected: autoCheck, userEdited: true, ...(matchResult !== undefined && { matchResult }) }, generation);
        }));
      `),
    },
    {
      name: 'library handleRestartMatch clear',
      filename: LIBRARY_HOOK,
      code: withTrustRoots(`
        setRows(prev => prev.map(r => isLibraryDbDuplicate(r.book) ? r : stampRow({ ...r, matchResult: undefined }, generation)));
      `),
    },

    {
      name: 'manual mergeMatchResults',
      filename: MANUAL_HOOK,
      code: withTrustRoots(`
        setRows(prev => prev.map(row => {
          const match = resultMap.get(row.book.path);
          if (!match) return row;
          return stampRow(mergeMatchIntoRow(row, match), generation);
        }));
      `),
    },
    {
      name: 'manual scan map literal',
      filename: MANUAL_HOOK,
      code: withTrustRoots(`
        const newRows = result.discoveries.map((book) => stampRow({
          book,
          selected: !book.isDuplicate,
          userEdited: false,
          edited: { title: book.parsedTitle, author: book.parsedAuthor || '', series: book.parsedSeries || '' },
        }, scanGeneration));
      `),
    },
    {
      name: 'manual handleEdit shorthand matchResult',
      filename: MANUAL_HOOK,
      code: withTrustRoots(`
        setRows(prev => prev.map((r, i) => {
          const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);
          return stampRow({ ...r, edited: state, selected: autoCheck, userEdited: true, matchResult }, generation);
        }));
      `),
    },
    {
      name: 'manual handleRestartMatch clear',
      filename: MANUAL_HOOK,
      code: withTrustRoots(`
        setRows(prev => prev.map(r => r.book.isDuplicate ? r : stampRow({ ...r, matchResult: undefined }, generation)));
      `),
    },

    {
      name: 'TSAsExpression-wrapped producer in arg-0',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow({ ...r, matchResult: fresh } as ImportRow, generation);'),
    },
    {
      name: 'TSSatisfiesExpression-wrapped producer in arg-0',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow({ ...r, matchResult: fresh } satisfies ImportRow, generation);'),
    },
    {
      name: 'ConditionalExpression — both branches reach arg-0',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(cond ? { ...r, matchResult: a } : { ...r, matchResult: b }, generation);'),
    },
    {
      name: 'TSNonNullExpression-wrapped producer in arg-0',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow({ ...r, matchResult: fresh }!, generation);'),
    },
    {
      // The parser currently erases parentheses; this fails if it starts preserving that node.
      name: 'parenthesized producer in arg-0',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(({ ...r, matchResult: fresh }), generation);'),
    },

    {
      name: 'aliased stampRow import is trusted',
      filename: LIBRARY_HOOK,
      code: `import { stampRow as s } from '@/lib/repick-corroboration.js';\nconst out = s({ ...r, matchResult: fresh }, generation);`,
    },
    {
      name: 'mergeMatchIntoRow from the direct module is not a P2 producer',
      filename: LIBRARY_HOOK,
      code: `import { mergeMatchIntoRow } from '@/components/manual-import/mergeMatchIntoRow.js';\nsetRows(prev => prev.map(row => mergeMatchIntoRow(row, match)));`,
    },

    {
      name: 'member read inside an updater (handleDeselectPending)',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('setRows(prev => prev.map(r => (!r.matchResult && !isLibraryDbDuplicate(r.book)) ? { ...r, selected: false } : r));'),
    },
    {
      name: 'same-named local declarator with no object literal (handleEdit)',
      filename: MANUAL_HOOK,
      code: withTrustRoots('const matchResult = upgradeMatchConfidence(r.matchResult, state.metadata, r.edited.metadata);'),
    },
    {
      name: 'the ImportRow interface member is a TSPropertySignature, not an ObjectExpression',
      filename: MANUAL_HOOK,
      code: 'interface ImportRow { readonly matchResult?: MatchResult | undefined; readonly matchGeneration?: number | undefined; }',
    },
    {
      name: 'annotated function parameters',
      filename: MANUAL_HOOK,
      code: 'function f(row: ImportRow, matchResult: MatchResult) { return row; }',
    },

    { name: 'setRows([])', filename: MANUAL_HOOK, code: 'setRows([]);' },
    { name: 'setRows(newRows)', filename: LIBRARY_HOOK, code: 'setRows(newRows);' },
    {
      name: 'onDeselectAccepted selected:false',
      filename: LIBRARY_HOOK,
      code: 'setRows((prev) => prev.map((r) => (paths.has(r.book.path) ? { ...r, selected: false } : r)));',
    },
    {
      name: 'handleToggle selected flip',
      filename: MANUAL_HOOK,
      code: 'setRows(prev => prev.map((r, i) => i === index ? { ...r, selected: !r.selected } : r));',
    },
    {
      name: 'block-bodied handleSelectAll updater',
      filename: LIBRARY_HOOK,
      code: `
        setRows(prev => {
          const selectableRows = prev.filter(r => !isLibraryDbDuplicate(r.book));
          const allSelected = selectableRows.length > 0 && selectableRows.every(r => r.selected);
          return prev.map(r => isLibraryDbDuplicate(r.book) ? r : { ...r, selected: !allSelected });
        });
      `,
    },
    {
      name: 'block-bodied handleToggleAll updater',
      filename: MANUAL_HOOK,
      code: `
        setRows(prev => {
          const allSelected = prev.every(r => r.selected);
          return prev.map(r => ({ ...r, selected: !allSelected }));
        });
      `,
    },

    { name: 'applyCorroboration under its own file', filename: CORROBORATION_FILE, code: APPLY_CORROBORATION_WRITE },
    { name: 'mergeMatchIntoRow wasEdited return under its own file', filename: MERGE_FILE, code: MERGE_EARLY_RETURN },
    { name: 'mergeMatchIntoRow terminal return under its own file', filename: MERGE_FILE, code: MERGE_TERMINAL_RETURN },
  ],

  invalid: [
    {
      name: 'unstamped mergeMatchIntoRow result',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('setRows(prev => prev.map(row => mergeMatchIntoRow(row, match)));'),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'unstamped install',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('setRows(prev => prev.map(r => ({ ...r, matchResult: fresh })));'),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'unstamped clear — the property VALUE is never inspected',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('setRows(prev => prev.map(r => ({ ...r, matchResult: undefined })));'),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'unstamped shorthand key',
      filename: MANUAL_HOOK,
      code: withTrustRoots(`
        function patch(r) {
          const matchResult = f();
          return { ...r, matchResult };
        }
      `),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'unstamped conditional spread',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('setRows(prev => prev.map(r => ({ ...r, ...(matchResult !== undefined && { matchResult }) })));'),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'unstamped string-literal key',
      filename: LIBRARY_HOOK,
      code: withTrustRoots("setRows(prev => prev.map(r => ({ ...r, 'matchResult': fresh })));"),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'unstamped computed-constant key',
      filename: LIBRARY_HOOK,
      code: withTrustRoots("setRows(prev => prev.map(r => ({ ...r, ['matchResult']: fresh })));"),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'producer built into a const first, then handed to setRows',
      filename: LIBRARY_HOOK,
      code: withTrustRoots(`
        const newRows = rows.map(r => ({ ...r, matchResult: fresh }));
        setRows(newRows);
      `),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      // Two independent violations: arg-1 is not an Identifier and its producer does not reach arg-0.
      name: 'producer in the wrong argument position',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(row, pickGeneration({ matchResult }));'),
      errors: [{ messageId: 'generationNotIdentifier' }, { messageId: 'unstamped' }],
    },
    {
      // AC2 Property-step negative: the nested key does not land on the row.
      name: 'nested under a Property — the key does not land on the row',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow({ ...r, meta: { matchResult } }, generation);'),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      // Array spread must not count as the object-spread key-hoist exception.
      name: 'spread into an array, not an object literal',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow([...({ ...r, matchResult: fresh })], generation);'),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'producer directly at arg-1 of a trusted stampRow call',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(row, { matchResult: fresh });'),
      errors: [{ messageId: 'generationNotIdentifier' }, { messageId: 'unstamped' }],
    },
    {
      name: 'spread of a producer built elsewhere — the walk ends at its declarator',
      filename: LIBRARY_HOOK,
      code: withTrustRoots(`
        const patch = { matchResult: fresh };
        const out = stampRow({ ...r, ...patch }, generation);
      `),
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'a local stampRow is not the trusted binding',
      filename: LIBRARY_HOOK,
      code: `const stampRow = (r) => r;\nconst out = stampRow({ ...r, matchResult: fresh }, generation);`,
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'a local mergeMatchIntoRow is not a P2 producer, but the literal beside it still reports',
      filename: LIBRARY_HOOK,
      code: `${STAMP_IMPORT}
        const mergeMatchIntoRow = (row, match) => row;
        const merged = mergeMatchIntoRow(row, match);
        const out = { ...merged, matchResult: match };
      `,
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'aliased barrel merge import is still a P2 producer (F7)',
      filename: LIBRARY_HOOK,
      code: `import { mergeMatchIntoRow as merge } from '@/components/manual-import';\nsetRows(prev => prev.map(row => merge(row, match)));`,
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'a wrong-module stampRow import does not exempt a producer (F7)',
      filename: LIBRARY_HOOK,
      code: `import { stampRow } from '@/lib/some-other-module.js';\nconst out = stampRow({ ...r, matchResult: fresh }, generation);`,
      errors: [{ messageId: 'unstamped' }],
    },

    {
      name: 'generation from a CallExpression',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(mergeMatchIntoRow(row, match), nextGeneration());'),
      errors: [{ messageId: 'generationNotIdentifier' }],
    },
    {
      name: 'generation from a Literal (F8)',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(row, 1);'),
      errors: [{ messageId: 'generationNotIdentifier' }],
    },
    {
      name: 'generation from a MemberExpression (F8)',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(row, state.generation);'),
      errors: [{ messageId: 'generationNotIdentifier' }],
    },
    {
      // TS2554 is redundant coverage, not a guarantee that an absent generation stays invalid.
      name: 'generation omitted entirely',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow(row);'),
      errors: [{ messageId: 'generationNotIdentifier' }],
    },
    {
      // Arg zero is stamped; only the independent missing-generation check should fire.
      name: 'stamped producer with the generation omitted',
      filename: LIBRARY_HOOK,
      code: withTrustRoots('const out = stampRow({ ...r, matchResult: fresh });'),
      errors: [{ messageId: 'generationNotIdentifier' }],
    },

    {
      name: 'applyCorroboration shape under a hook filename',
      filename: LIBRARY_HOOK,
      code: APPLY_CORROBORATION_WRITE,
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'mergeMatchIntoRow wasEdited return under a hook filename',
      filename: LIBRARY_HOOK,
      code: MERGE_EARLY_RETURN,
      errors: [{ messageId: 'unstamped' }],
    },
    {
      name: 'mergeMatchIntoRow terminal return under a hook filename',
      filename: LIBRARY_HOOK,
      code: MERGE_TERMINAL_RETURN,
      errors: [{ messageId: 'unstamped' }],
    },
  ],
});
