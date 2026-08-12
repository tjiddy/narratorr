/**
 * Returns keys owned only by other registry types for settings leak guards.
 * Defaults cannot reveal dynamic or required-without-default keys; tests must name those.
 */
export function foreignRegistryKeys<T extends string>(
  ownType: T,
  allTypes: readonly T[],
  registry: Record<T, { defaultSettings: object }>,
): string[] {
  const ownKeys = new Set(Object.keys(registry[ownType].defaultSettings));
  return [
    ...new Set(
      allTypes
        .filter((t) => t !== ownType)
        .flatMap((t) => Object.keys(registry[t].defaultSettings))
        .filter((k) => !ownKeys.has(k)),
    ),
  ];
}
