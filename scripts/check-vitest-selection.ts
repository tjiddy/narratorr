import { readFileSync } from 'node:fs';
import { runVitestSelectionGuard } from './vitest-selection-guard.js';

// CI entry point for the Windows job's AC9 step: `tsx scripts/check-vitest-selection.ts <report>`.
process.exit(
  runVitestSelectionGuard(process.argv[2] ?? 'vitest-windows.json', {
    readReport: (path) => readFileSync(path, 'utf-8'),
    log: (line) => console.log(line),
  }),
);
