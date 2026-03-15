import { describe, it, expect, vi } from 'vitest';
import { findExistingBranch, checkoutOrCreateBranch } from './lib.ts';

describe('findExistingBranch', () => {
  describe('local branch detection', () => {
    it('returns branch name and source "local" when local branch exists', () => {
      const mockGit = vi.fn()
        .mockReturnValueOnce('  feature/issue-42-some-title'); // git branch --list
      const result = findExistingBranch('42', mockGit);
      expect(result).toEqual({ branch: 'feature/issue-42-some-title', source: 'local' });
      expect(mockGit).toHaveBeenCalledWith('branch', '--list', 'feature/issue-42-*');
    });

    it('returns null when no local or remote branch matches', () => {
      const mockGit = vi.fn()
        .mockReturnValueOnce('') // git branch --list (empty)
        .mockReturnValueOnce(''); // git branch -r --list (empty)
      const result = findExistingBranch('42', mockGit);
      expect(result).toBeNull();
    });
  });

  describe('remote branch detection', () => {
    it('returns branch name and source "remote" when remote branch exists but not local', () => {
      const mockGit = vi.fn()
        .mockReturnValueOnce('') // git branch --list (empty)
        .mockReturnValueOnce('  origin/feature/issue-42-some-title'); // git branch -r --list
      const result = findExistingBranch('42', mockGit);
      expect(result).toEqual({ branch: 'feature/issue-42-some-title', source: 'remote' });
      expect(mockGit).toHaveBeenCalledWith('branch', '-r', '--list', 'origin/feature/issue-42-*');
    });

    it('returns null when git commands throw', () => {
      const mockGit = vi.fn()
        .mockImplementationOnce(() => { throw new Error('git error'); })
        .mockImplementationOnce(() => { throw new Error('git error'); });
      const result = findExistingBranch('42', mockGit);
      expect(result).toBeNull();
    });
  });

  describe('priority', () => {
    it('prefers local branch over remote', () => {
      const mockGit = vi.fn()
        .mockReturnValueOnce('  feature/issue-42-local-title'); // local match
      const result = findExistingBranch('42', mockGit);
      expect(result?.source).toBe('local');
      expect(mockGit).toHaveBeenCalledTimes(1);
    });
  });
});

describe('checkoutOrCreateBranch', () => {
  it('creates new branch when no existing branch found', () => {
    const calls: string[][] = [];
    const mockGit = vi.fn((...args: string[]) => {
      calls.push(args);
      if (args[0] === 'branch' && args[1] === '--list') return '';
      if (args[0] === 'branch' && args[1] === '-r') return '';
      return '';
    });

    const result = checkoutOrCreateBranch('42', 'feature/issue-42-new-title', mockGit);
    expect(result).toEqual({ branch: 'feature/issue-42-new-title', resumed: false });

    // Should checkout main, pull, then checkout -b
    expect(calls).toContainEqual(['checkout', 'main']);
    expect(calls).toContainEqual(['pull', 'origin', 'main']);
    expect(calls).toContainEqual(['checkout', '-b', 'feature/issue-42-new-title']);
  });

  it('checks out existing local branch and returns resumed=true', () => {
    const calls: string[][] = [];
    const mockGit = vi.fn((...args: string[]) => {
      calls.push(args);
      if (args[0] === 'branch' && args[1] === '--list') return '  feature/issue-42-existing';
      return '';
    });

    const result = checkoutOrCreateBranch('42', 'feature/issue-42-new', mockGit);
    expect(result).toEqual({ branch: 'feature/issue-42-existing', resumed: true });

    // Should NOT call checkout main or checkout -b
    const checkoutMain = calls.find(c => c[0] === 'checkout' && c[1] === 'main');
    expect(checkoutMain).toBeUndefined();
    const checkoutNew = calls.find(c => c[0] === 'checkout' && c[1] === '-b');
    expect(checkoutNew).toBeUndefined();

    // Should checkout existing branch directly
    expect(calls).toContainEqual(['checkout', 'feature/issue-42-existing']);
  });

  it('fetches and checks out remote branch with fetch before checkout', () => {
    const calls: string[][] = [];
    const mockGit = vi.fn((...args: string[]) => {
      calls.push(args);
      if (args[0] === 'branch' && args[1] === '--list') return '';
      if (args[0] === 'branch' && args[1] === '-r') return '  origin/feature/issue-42-remote';
      return '';
    });

    const result = checkoutOrCreateBranch('42', 'feature/issue-42-new', mockGit);
    expect(result).toEqual({ branch: 'feature/issue-42-remote', resumed: true });

    // Fetch must happen before checkout
    expect(calls).toContainEqual(['fetch', 'origin', 'feature/issue-42-remote']);
    const fetchIdx = calls.findIndex(c => c[0] === 'fetch');
    const checkoutIdx = calls.findIndex(c => c[0] === 'checkout' && c[1] === 'feature/issue-42-remote');
    expect(fetchIdx).toBeLessThan(checkoutIdx);
  });

  it('stashes before branch operations and pops after', () => {
    const calls: string[][] = [];
    const mockGit = vi.fn((...args: string[]) => {
      calls.push(args);
      if (args[0] === 'branch' && args[1] === '--list') return '';
      if (args[0] === 'branch' && args[1] === '-r') return '';
      return '';
    });

    checkoutOrCreateBranch('42', 'feature/issue-42-new', mockGit);

    const stashIdx = calls.findIndex(c => c[0] === 'stash' && c[1] === '--include-untracked');
    const popIdx = calls.findIndex(c => c[0] === 'stash' && c[1] === 'pop');
    expect(stashIdx).toBeGreaterThanOrEqual(0);
    expect(popIdx).toBeGreaterThan(stashIdx);
  });
});
