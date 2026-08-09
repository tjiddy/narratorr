export interface RequiredField {
  path: string;
  message: string;
}

export interface RegistryEntry<TSettings> {
  label: string;
  defaultSettings: TSettings;
  requiredFields: RequiredField[];
  viewSubtitle: (settings: Record<string, unknown>) => string;
}
