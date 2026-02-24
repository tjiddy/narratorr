import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuthContext } from './useAuthContext';

describe('useAuthContext', () => {
  it('throws when used outside AuthProvider', () => {
    expect(() => {
      renderHook(() => useAuthContext());
    }).toThrow('useAuthContext must be used within an AuthProvider');
  });
});
