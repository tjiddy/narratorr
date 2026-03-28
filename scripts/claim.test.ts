import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findExistingBranch, checkoutOrCreateBranch, UnmergedFilesError } from './lib.ts';

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

describe('checkoutOrCreateBranch — unmerged file detection', () => {
  function makeMockGit(statusOutput: string) {
    const calls: string[][] = [];
    const mockGit = vi.fn((...args: string[]) => {
      calls.push(args);
      if (args[0] === 'status' && args[1] === '--porcelain') return statusOutput;
      if (args[0] === 'branch' && args[1] === '--list') return '';
      if (args[0] === 'branch' && args[1] === '-r') return '';
      return '';
    });
    return { mockGit, calls };
  }

  it('throws UnmergedFilesError for single UU file', () => {
    const { mockGit } = makeMockGit('UU some/file.ts');
    expect(() => checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit))
      .toThrow(UnmergedFilesError);
    try {
      checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(UnmergedFilesError);
      expect((e as UnmergedFilesError).files).toEqual(['some/file.ts']);
    }
  });

  it('throws UnmergedFilesError listing all conflicted files for multiple UU files', () => {
    const { mockGit } = makeMockGit('UU file1.ts\nUU file2.ts');
    try {
      checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(UnmergedFilesError);
      expect((e as UnmergedFilesError).files).toEqual(['file1.ts', 'file2.ts']);
    }
  });

  it('detects all unmerged status codes (AA, AU, UA, DD, UD, DU), not just UU', () => {
    const statuses = ['AA', 'AU', 'UA', 'DD', 'UD', 'DU'];
    for (const status of statuses) {
      const { mockGit } = makeMockGit(`${status} file-${status}.ts`);
      expect(() => checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit))
        .toThrow(UnmergedFilesError);
    }
  });

  it('does not throw for clean working tree (empty git status)', () => {
    const { mockGit } = makeMockGit('');
    expect(() => checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit))
      .not.toThrow();
  });

  it('does not throw for dirty but non-conflicted tree (M and ?? statuses)', () => {
    const { mockGit } = makeMockGit(' M modified.ts\n?? untracked.ts');
    expect(() => checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit))
      .not.toThrow();
  });

  it('runs git status --porcelain before git stash --include-untracked', () => {
    const { mockGit, calls } = makeMockGit('');
    checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit);
    const statusIdx = calls.findIndex(c => c[0] === 'status' && c[1] === '--porcelain');
    const stashIdx = calls.findIndex(c => c[0] === 'stash' && c[1] === '--include-untracked');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(stashIdx).toBeGreaterThan(statusIdx);
  });

  it('propagates git status --porcelain failure cleanly (not swallowed)', () => {
    const mockGit = vi.fn((...args: string[]) => {
      if (args[0] === 'status') throw new Error('git status failed');
      return '';
    });
    expect(() => checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit))
      .toThrow('git status failed');
  });

  it('catch + die produces clean CLI error listing conflicted files and resolution guidance', () => {
    const error = new UnmergedFilesError(['src/a.ts', 'src/b.ts']);
    // Verify error has the right structure for claim.ts to format
    expect(error).toBeInstanceOf(Error);
    expect(error.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(error.message).toContain('src/a.ts');
    expect(error.message).toContain('src/b.ts');
    // Message should include resolution guidance
    expect(error.message.toLowerCase()).toMatch(/resolve|conflict/);
  });

  it('UnmergedFilesError is distinguishable from generic Error via instanceof', () => {
    const unmergedErr = new UnmergedFilesError(['file.ts']);
    const genericErr = new Error('some other error');
    expect(unmergedErr instanceof UnmergedFilesError).toBe(true);
    expect(genericErr instanceof UnmergedFilesError).toBe(false);
  });

  it('non-UnmergedFilesError exceptions propagate through checkoutOrCreateBranch', () => {
    const mockGit = vi.fn((...args: string[]) => {
      if (args[0] === 'status') return ''; // clean status
      if (args[0] === 'branch' && args[1] === '--list') return '';
      if (args[0] === 'branch' && args[1] === '-r') return '';
      if (args[0] === 'stash') return '';
      if (args[0] === 'checkout' && args[1] === 'main') throw new Error('checkout failed');
      return '';
    });
    expect(() => checkoutOrCreateBranch('42', 'feature/issue-42-test', mockGit))
      .toThrow('checkout failed');
  });
});

describe('claim.ts script — error handling integration', () => {
  const originalArgv2 = process.argv[2];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv[2] = originalArgv2;
    vi.doUnmock('./lib.ts');
  });

  function mockLib(overrides: Record<string, unknown> = {}) {
    const defaults = {
      gh: vi.fn(() => '#42 [open] Test issue\nlabels: status/ready-for-dev'),
      ghSafe: vi.fn(() => ({ ok: true, output: '' })),
      ghSetLabels: vi.fn(() => ''),
      gitea: vi.fn(() => { throw new Error('gitea() removed — use gh()'); }),
      giteaSafe: vi.fn(() => { throw new Error('giteaSafe() removed — use ghSafe()'); }),
      JQ: { ISSUE: '', COMMENTS: '', PRS_LIST: '' },
      GH_FIELDS: { ISSUE: '', PRS_LIST: '' },
      parseLabels: vi.fn(() => ['status/ready-for-dev']),
      replaceLabel: vi.fn(() => ['status/in-progress']),
      slugify: vi.fn(() => 'test-issue'),
      withTempFile: vi.fn(),
      die: vi.fn(() => { throw new Error('die-called'); }),
      checkoutOrCreateBranch: vi.fn(() => ({ branch: 'feature/issue-42-test', resumed: false })),
      UnmergedFilesError,
    };
    vi.doMock('./lib.ts', () => ({ ...defaults, ...overrides }));
  }

  it('catches UnmergedFilesError and calls die() with conflicted file list and resolution guidance', async () => {
    const dieMock = vi.fn(() => { throw new Error('die-called'); });
    mockLib({
      checkoutOrCreateBranch: vi.fn(() => {
        throw new UnmergedFilesError(['src/a.ts', 'src/b.ts']);
      }),
      die: dieMock,
    });
    process.argv[2] = '42';

    await expect(() => import('./claim.ts')).rejects.toThrow('die-called');

    expect(dieMock).toHaveBeenCalledOnce();
    expect(dieMock).toHaveBeenCalledWith(
      expect.stringContaining('Unmerged files detected'),
    );
    expect(dieMock).toHaveBeenCalledWith(expect.stringContaining('src/a.ts'));
    expect(dieMock).toHaveBeenCalledWith(expect.stringContaining('src/b.ts'));
    expect(dieMock).toHaveBeenCalledWith(expect.stringContaining('git add'));
  });

  it('rethrows non-UnmergedFilesError exceptions without calling die()', async () => {
    const dieMock = vi.fn(() => { throw new Error('die-called'); });
    mockLib({
      checkoutOrCreateBranch: vi.fn(() => {
        throw new Error('checkout failed');
      }),
      die: dieMock,
    });
    process.argv[2] = '42';

    await expect(() => import('./claim.ts')).rejects.toThrow('checkout failed');
    expect(dieMock).not.toHaveBeenCalled();
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
