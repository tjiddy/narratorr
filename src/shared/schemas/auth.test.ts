import { describe, it, expect } from 'vitest';
import { setupCredentialsSchema, changePasswordSchema } from './auth.js';

describe('setupCredentialsSchema', () => {
  it('accepts a 1-character password', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty string password', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: '' });
    expect(result.success).toBe(false);
  });

  it('accepts a 128-character password (max boundary)', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: 'a'.repeat(128) });
    expect(result.success).toBe(true);
  });
});

describe('changePasswordSchema', () => {
  it('accepts a 1-character newPassword', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty string newPassword', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: '' });
    expect(result.success).toBe(false);
  });

  it('accepts a 128-character newPassword (max boundary)', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'a'.repeat(128) });
    expect(result.success).toBe(true);
  });
});
