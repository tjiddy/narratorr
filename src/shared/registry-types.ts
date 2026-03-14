/** A field path + validation message used by registry-driven forms. */
export interface RequiredField {
  path: string;
  message: string;
}

/** Base metadata shape shared by all entity-type registries. */
export interface RegistryEntry<TSettings> {
  label: string;
  defaultSettings: TSettings;
  requiredFields: RequiredField[];
  viewSubtitle: (settings: Record<string, unknown>) => string;
}
