import { type AppSettings, DEFAULT_SETTINGS } from './registry.js';

// ---------------------------------------------------------------------------
// DeepPartial utility type — allows overriding any nested field
// ---------------------------------------------------------------------------

export type DeepPartial<T> = {
  [K in keyof T]?: (T[K] extends object ? DeepPartial<T[K]> : T[K]) | undefined;
};

// ---------------------------------------------------------------------------
// Deep merge — preserves falsy-but-valid values (0, false, '')
// ---------------------------------------------------------------------------

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: DeepPartial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const overrideVal = overrides[key];
    if (overrideVal === undefined) continue;
    const baseVal = base[key];
    if (
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as DeepPartial<Record<string, unknown>>,
      ) as T[keyof T];
    } else {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deep clone — structuredClone for full isolation from DEFAULT_SETTINGS
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ---------------------------------------------------------------------------
// Factory — produces complete AppSettings with deep-merged overrides
// ---------------------------------------------------------------------------

export function createMockSettings(overrides?: DeepPartial<AppSettings>): AppSettings {
  if (!overrides) return deepClone(DEFAULT_SETTINGS);
  return deepMerge(deepClone(DEFAULT_SETTINGS), overrides) as AppSettings;
}
