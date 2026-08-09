import os from 'os';
import { serializeError } from './serialize-error.js';

// Match Pino's shape so last-resort crash output stays machine-parseable.
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

// Bypass Pino's async buffer and never let crash logging throw.
export function logCrash(msg: string, err: unknown): void {
  try {
    process.stderr.write(buildCrashLogLine(msg, err) + '\n');
  } catch {
    // stderr failed; nothing else remains.
  }
}
