import { describe, expect, it } from 'vitest';
import { changePasswordSchema, loginSchema, setupCredentialsSchema } from './auth.js';

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

describe('loginSchema — password spaces preserved', () => {
  it('preserves leading/trailing spaces in password (not trimmed)', () => {
    const result = loginSchema.safeParse({ username: 'u', password: ' p ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.password).toBe(' p ');
  });

  it('rejects whitespace-only username', () => {
    const result = loginSchema.safeParse({ username: '   ', password: 'pass' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from username', () => {
    const result = loginSchema.safeParse({ username: '  admin  ', password: 'pass' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.username).toBe('admin');
  });
});

describe('setupCredentialsSchema — password spaces preserved', () => {
  it('preserves leading/trailing spaces in password (not trimmed)', () => {
    const result = setupCredentialsSchema.safeParse({ username: 'admin', password: ' p ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.password).toBe(' p ');
  });

  it('trims leading/trailing spaces from username', () => {
    const result = setupCredentialsSchema.safeParse({ username: '  admin  ', password: 'pass' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.username).toBe('admin');
  });
});

describe('changePasswordSchema — password spaces preserved', () => {
  it('preserves spaces in currentPassword (not trimmed)', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: ' old ', newPassword: 'new' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currentPassword).toBe(' old ');
  });

  it('preserves spaces in newPassword (not trimmed)', () => {
    const result = changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: ' new ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.newPassword).toBe(' new ');
  });

  it('trims leading/trailing spaces from newUsername when provided', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'new',
      newUsername: '  user  ',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.newUsername).toBe('user');
  });

  it('rejects whitespace-only newUsername when provided', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'new',
      newUsername: '   ',
    });
    expect(result.success).toBe(false);
  });
});
