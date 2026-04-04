import { describe, it, expect } from 'vitest';
import { createIndexerFormSchema, createIndexerSchema, updateIndexerSchema } from './indexer.js';

describe('createIndexerFormSchema — flareSolverrUrl validation', () => {
  const baseData = {
    name: 'Test Indexer',
    type: 'abb' as const,
    enabled: true,
    priority: 50,
    settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
  };

  it('accepts valid FlareSolverr URL', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, flareSolverrUrl: 'http://flaresolverr:8191' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty FlareSolverr URL (normalizes to undefined)', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, flareSolverrUrl: '' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.flareSolverrUrl).toBeUndefined();
    }
  });

  it('accepts undefined FlareSolverr URL', () => {
    const result = createIndexerFormSchema.safeParse(baseData);
    expect(result.success).toBe(true);
  });

  it('rejects invalid FlareSolverr URL', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, flareSolverrUrl: 'not-a-url' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const urlError = result.error.issues.find(
        i => i.path.includes('flareSolverrUrl'),
      );
      expect(urlError).toBeDefined();
      expect(urlError?.message).toBe('Must be a valid URL');
    }
  });

  it('strips trailing slashes from FlareSolverr URL', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, flareSolverrUrl: 'http://flaresolverr:8191/' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.flareSolverrUrl).toBe('http://flaresolverr:8191');
    }
  });

  it('trims whitespace from FlareSolverr URL', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, flareSolverrUrl: '  http://flaresolverr:8191  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.flareSolverrUrl).toBe('http://flaresolverr:8191');
    }
  });

  it('accepts FlareSolverr URL for torznab type', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      type: 'torznab',
      settings: { apiUrl: 'https://tracker.test', apiKey: 'key', flareSolverrUrl: 'http://proxy:8191' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts FlareSolverr URL for newznab type', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      type: 'newznab',
      settings: { apiUrl: 'https://nzb.test', apiKey: 'key', flareSolverrUrl: 'http://proxy:8191' },
    });
    expect(result.success).toBe(true);
  });

  it('normalizes whitespace-only FlareSolverr URL to undefined', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, flareSolverrUrl: '   ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.flareSolverrUrl).toBeUndefined();
    }
  });
});

describe('createIndexerFormSchema — MAM required-field validation', () => {
  const mamBase = {
    name: 'MAM Indexer',
    type: 'myanonamouse' as const,
    enabled: true,
    priority: 50,
  };

  it('rejects when mamId is missing', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { baseUrl: 'https://mam.example.com' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const mamIdError = result.error.issues.find(
        i => i.path.includes('mamId'),
      );
      expect(mamIdError).toBeDefined();
      expect(mamIdError?.message).toBe('MAM ID is required');
    }
  });

  it('rejects when mamId is empty string', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { mamId: '', baseUrl: 'https://mam.example.com' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const mamIdError = result.error.issues.find(
        i => i.path.includes('mamId'),
      );
      expect(mamIdError).toBeDefined();
    }
  });

  it('accepts when mamId is provided', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { mamId: 'my-mam-id-cookie' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts when mamId and baseUrl are both provided', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { mamId: 'my-mam-id-cookie', baseUrl: 'https://mam.example.com' },
    });
    expect(result.success).toBe(true);
  });
});

const validCreateIndexer = {
  name: 'My Indexer',
  type: 'newznab' as const,
  settings: {},
};

describe('createIndexerSchema — trim behavior', () => {
  it('rejects whitespace-only name', () => {
    const result = createIndexerSchema.safeParse({ ...validCreateIndexer, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createIndexerSchema.safeParse({ ...validCreateIndexer, name: '  My Indexer  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Indexer');
  });
});

describe('updateIndexerSchema — trim behavior', () => {
  it('rejects whitespace-only name when provided', () => {
    const result = updateIndexerSchema.safeParse({ name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name when provided', () => {
    const result = updateIndexerSchema.safeParse({ name: '  My Indexer  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Indexer');
  });
});

describe('createIndexerSchema — settings credential trim (#272)', () => {
  it('trims apiUrl in settings record', () => {
    const result = createIndexerSchema.safeParse({
      ...validCreateIndexer,
      settings: { apiUrl: '  https://indexer.test  ', apiKey: 'key' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.apiUrl).toBe('https://indexer.test');
  });

  it('trims apiKey in settings record', () => {
    const result = createIndexerSchema.safeParse({
      ...validCreateIndexer,
      settings: { apiUrl: 'https://indexer.test', apiKey: '  key123  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.apiKey).toBe('key123');
  });

  it('leaves non-credential settings fields untouched', () => {
    const result = createIndexerSchema.safeParse({
      ...validCreateIndexer,
      settings: { apiUrl: 'https://test', hostname: '  host  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.hostname).toBe('  host  ');
  });
});

describe('updateIndexerSchema — settings credential trim (#272)', () => {
  it('trims apiUrl in settings record', () => {
    const result = updateIndexerSchema.safeParse({
      settings: { apiUrl: '  https://indexer.test  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings!.apiUrl).toBe('https://indexer.test');
  });

  it('trims apiKey in settings record', () => {
    const result = updateIndexerSchema.safeParse({
      settings: { apiKey: '  key456  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings!.apiKey).toBe('key456');
  });
});

const validCreateIndexerForm = {
  name: 'My Indexer',
  type: 'abb' as const,
  enabled: true,
  priority: 50,
  settings: { hostname: 'audiobookbay.lu' },
};

describe('createIndexerFormSchema — trim behavior', () => {
  it('rejects whitespace-only name', () => {
    const result = createIndexerFormSchema.safeParse({ ...validCreateIndexerForm, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createIndexerFormSchema.safeParse({ ...validCreateIndexerForm, name: '  My Indexer  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Indexer');
  });
});

describe('createIndexerFormSchema — apiUrl/apiKey trim (#272)', () => {
  it('trims leading/trailing whitespace from settings.apiUrl', () => {
    const input = {
      ...validCreateIndexerForm,
      type: 'newznab' as const,
      settings: { apiUrl: '  https://indexer.test  ', apiKey: 'key123' },
    };
    const result = createIndexerFormSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.apiUrl).toBe('https://indexer.test');
  });

  it('trims leading/trailing whitespace from settings.apiKey', () => {
    const input = {
      ...validCreateIndexerForm,
      type: 'newznab' as const,
      settings: { apiUrl: 'https://indexer.test', apiKey: '  key123  ' },
    };
    const result = createIndexerFormSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.apiKey).toBe('key123');
  });

  it('normalizes whitespace-only apiUrl to empty string (rejected by superRefine for newznab)', () => {
    const input = {
      ...validCreateIndexerForm,
      type: 'newznab' as const,
      settings: { apiUrl: '   ', apiKey: 'key123' },
    };
    const result = createIndexerFormSchema.safeParse(input);
    // superRefine requires apiUrl for newznab, so trimmed whitespace-only is rejected
    expect(result.success).toBe(false);
  });
});

describe('createIndexerFormSchema — baseUrl trim (#284)', () => {
  const baseData = {
    name: 'Test Indexer',
    type: 'abb' as const,
    enabled: true,
    priority: 50,
    settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
  };

  it('trims leading/trailing whitespace from settings.baseUrl', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, baseUrl: '  https://custom.base  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.baseUrl).toBe('https://custom.base');
  });

  it('whitespace-only baseUrl produces empty string', () => {
    const result = createIndexerFormSchema.safeParse({
      ...baseData,
      settings: { ...baseData.settings, baseUrl: '   ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.baseUrl).toBe('');
  });
});

describe('createIndexerFormSchema — mamUsername (#339)', () => {
  const mamBase = {
    name: 'MAM',
    type: 'myanonamouse' as const,
    enabled: true,
    priority: 50,
    settings: { mamId: 'test-id' },
  };

  it('#339 accepts mamUsername as optional string in MAM settings', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { ...mamBase.settings, mamUsername: 'TestUser' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.mamUsername).toBe('TestUser');
    }
  });

  it('#339 accepts omitted mamUsername (optional field)', () => {
    const result = createIndexerFormSchema.safeParse(mamBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.mamUsername).toBeUndefined();
    }
  });

  it('#339 mamUsername roundtrips through schema parse', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { ...mamBase.settings, mamUsername: 'RoundtripUser', isVip: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.mamUsername).toBe('RoundtripUser');
      expect(result.data.settings.isVip).toBe(true);
    }
  });
});

describe('createIndexerFormSchema — searchLanguages and searchType (#291)', () => {
  const mamBase = {
    name: 'MAM',
    type: 'myanonamouse' as const,
    enabled: true,
    priority: 50,
    settings: { mamId: 'test-id' },
  };

  it('accepts searchLanguages as a number array', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { ...mamBase.settings, searchLanguages: [1, 36], searchType: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.searchLanguages).toEqual([1, 36]);
  });

  it('accepts empty searchLanguages array (unrestricted search)', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { ...mamBase.settings, searchLanguages: [], searchType: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.searchLanguages).toEqual([]);
  });

  it('accepts searchType: 0 (falsy but valid — all torrents)', () => {
    const result = createIndexerFormSchema.safeParse({
      ...mamBase,
      settings: { ...mamBase.settings, searchLanguages: [1], searchType: 0 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.searchType).toBe(0);
  });

  it('accepts omitted searchLanguages and searchType (both optional)', () => {
    const result = createIndexerFormSchema.safeParse(mamBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.searchLanguages).toBeUndefined();
      expect(result.data.settings.searchType).toBeUndefined();
    }
  });
});
