# Technical Debt

All items graduated to #448. New items discovered after graduation listed below.

- **scheduleCron/scheduleTimeoutLoop untested error paths**: Both functions in `jobs/index.ts` have error handling (catch blocks that log and retry) but no unit tests exercise them. Pre-existing — discovered while reviewing coverage for #430.
