import os from 'os';
import { serializeError } from './serialize-error.js';

/**
 * Build a Pino-shaped JSON line for a fatal crash event.
 *
 * Pure function (modulo `Date.now()`, `process.pid`, `os.hostname()`) so
 * tests can verify the shape directly. Output matches the JSON layout the
 * rest of the application's logs use, so docker-logs-style tooling can
 * parse crash entries uniformly with normal Pino output.
 */
export function buildCrashLogLine(msg: string, err: unknown): string {
  return JSON.stringify({
    level: 60,
    time: Date.now(),
    pid: process.pid,
    hostname: os.hostname(),
    error: serializeError(err),
    msg,
  });
}

/**
 * Synchronously write a fatal crash log to stderr.
 *
 * Bypasses Pino's async buffer (sonic-boom) so the log flushes before
 * `process.exit()` actually terminates the process — Pino-buffered fatal
 * logs were the bug we hit when the original handlers in `src/server/index.ts`
 * appeared silent. The try/catch is a last-resort safeguard for the case where
 * stderr itself is unavailable; there's nothing useful we could do at that
 * point and we don't want the crash handler to itself throw.
 */
export function logCrash(msg: string, err: unknown): void {
  try {
    process.stderr.write(buildCrashLogLine(msg, err) + '\n');
  } catch {
    /* last-resort: stderr write failed, nothing else we can do */
  }
}
