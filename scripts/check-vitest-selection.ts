import { appendFileSync, readFileSync } from 'node:fs';
import { runVitestGuard } from './vitest-selection-guard.js';

// CI entry point for the Windows job's guard step:
//   tsx scripts/check-vitest-selection.ts <report> --exit-code=<n> --log=<path>
// With no flags it behaves exactly as it did before #2445: selection checks against the report.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

process.exit(
  runVitestGuard(process.argv.slice(2), {
    readReport: (path) => readFileSync(path, 'utf-8'),
    readLog: (path) => readFileSync(path, 'utf-8'),
    log: (line) => console.log(line),
    // Unset outside Actions, where the annotation in the step log is the whole diagnostic.
    appendStepSummary: (line) => {
      if (summaryPath !== undefined && summaryPath !== '') appendFileSync(summaryPath, `${line}\n`);
    },
  }),
);
