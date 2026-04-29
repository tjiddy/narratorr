import { describe, it, expect } from 'vitest';
import os from 'os';
import { buildCrashLogLine } from './crash-logger.js';

describe('buildCrashLogLine', () => {
  it('produces valid JSON', () => {
    const line = buildCrashLogLine('something broke', new Error('boom'));
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('emits all Pino-shaped fields', () => {
    const line = buildCrashLogLine('something broke', new Error('boom'));
    const parsed = JSON.parse(line);

    expect(parsed).toHaveProperty('level');
    expect(parsed).toHaveProperty('time');
    expect(parsed).toHaveProperty('pid');
    expect(parsed).toHaveProperty('hostname');
    expect(parsed).toHaveProperty('error');
    expect(parsed).toHaveProperty('msg');
  });

  it('uses level 60 (Pino fatal) so log filters route it as fatal', () => {
    const line = buildCrashLogLine('msg', new Error());
    expect(JSON.parse(line).level).toBe(60);
  });

  it('uses current process.pid and os.hostname()', () => {
    const line = buildCrashLogLine('msg', new Error());
    const parsed = JSON.parse(line);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.hostname).toBe(os.hostname());
  });

  it('uses ms-epoch timestamp matching Pino convention', () => {
    const before = Date.now();
    const line = buildCrashLogLine('msg', new Error());
    const after = Date.now();
    const parsed = JSON.parse(line);
    expect(parsed.time).toBeGreaterThanOrEqual(before);
    expect(parsed.time).toBeLessThanOrEqual(after);
  });

  it('passes the message through unchanged', () => {
    const line = buildCrashLogLine('the specific message', new Error());
    expect(JSON.parse(line).msg).toBe('the specific message');
  });

  it('serializes Error instances via serializeError (not raw {})', () => {
    const line = buildCrashLogLine('msg', new Error('boom'));
    const parsed = JSON.parse(line);
    // Raw JSON.stringify of Error gives {} — the regression we're guarding against.
    expect(parsed.error).not.toEqual({});
    expect(parsed.error.message).toBe('boom');
  });

  it('serializes string errors (uncaughtException / unhandledRejection can pass non-Errors)', () => {
    const line = buildCrashLogLine('msg', 'just a string');
    const parsed = JSON.parse(line);
    expect(parsed.error).toBeDefined();
  });

  it('serializes unknown rejection reasons (e.g., a thrown number) without throwing', () => {
    expect(() => buildCrashLogLine('msg', 42)).not.toThrow();
    expect(() => buildCrashLogLine('msg', null)).not.toThrow();
    expect(() => buildCrashLogLine('msg', undefined)).not.toThrow();
    expect(() => buildCrashLogLine('msg', { custom: 'object' })).not.toThrow();
  });
});
