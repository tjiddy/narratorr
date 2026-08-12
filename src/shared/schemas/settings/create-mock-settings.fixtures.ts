import { type AppSettings, DEFAULT_SETTINGS } from './registry.js';

export type DeepPartial<T> = {
  [K in keyof T]?: (T[K] extends object ? DeepPartial<T[K]> : T[K]) | undefined;
};

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

function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

export function createMockSettings(overrides?: DeepPartial<AppSettings>): AppSettings {
  if (!overrides) return deepClone(DEFAULT_SETTINGS);
  return deepMerge(deepClone(DEFAULT_SETTINGS), overrides) as AppSettings;
}
