export const FORMAT_LABELS: Record<string, string> = {
  m4b: 'M4B (recommended — chapters supported)',
  mp3: 'MP3 (no chapter support)',
};

export const MERGE_LABELS: Record<string, string> = {
  always: 'Always merge',
  'multi-file-only': 'Only when multiple files',
  never: 'Never (convert only)',
};

export const TAG_MODE_LABELS: Record<string, string> = {
  populate_missing: 'Populate missing (only write blank fields)',
  overwrite: 'Overwrite (write all fields)',
};
