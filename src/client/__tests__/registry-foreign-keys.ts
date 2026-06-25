/**
 * #908 family — registry-derived foreign-key helper shared by the four settings-form
 * leak-guard suites (NotifierCard, ImportListCard, IndexerCard, DownloadClientForm).
 *
 * Given the selected `ownType`, returns every settings key declared by ANOTHER registry
 * type's `defaultSettings`, minus any key `ownType` also declares — shared keys (e.g.
 * discord/slack `webhookUrl`, the import-list `apiKey`) are NOT foreign and must survive.
 * Registry-derived, so adding a new adapter type extends every suite's guard automatically
 * without a single test edit.
 *
 * Scope note: this only sees keys present in `defaultSettings`. Keys minted dynamically by a
 * provider's UI but absent from `defaultSettings` (e.g. hardcover's `shelfId`,
 * ImportListProviderSettings.tsx) are invisible here and must be asserted explicitly; and
 * per-type strict-schema keys that have no default (e.g. MAM's `isVip`/`classname`) are
 * likewise not derivable from defaults. Assert those by name where they matter.
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
