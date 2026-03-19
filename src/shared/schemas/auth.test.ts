import { describe, expect, it } from 'vitest';
import { changePasswordSchema, setupCredentialsSchema } from './auth.js';

describe('setupCredentialsSchema', () => {
  it('accepts 1-char password', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects empty string password', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: '' });
    expect(result.success).toBe(false);
  });

  it('empty-password error message is "Password is required"', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Password is required');
      expect(messages.join(' ')).not.toMatch(/8 characters/i);
    }
  });
});

describe('changePasswordSchema', () => {
  it('accepts 1-char newPassword', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects empty string newPassword', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: '' });
    expect(result.success).toBe(false);
  });

  it('empty-newPassword error message is "New password is required"', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('New password is required');
      expect(messages.join(' ')).not.toMatch(/8 characters/i);
    }
  });
});
