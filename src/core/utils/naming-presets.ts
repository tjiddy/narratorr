export interface NamingPreset {
  id: string;
  name: string;
  folderFormat: string;
  fileFormat: string;
}

export const NAMING_PRESETS: readonly NamingPreset[] = [
  {
    id: 'standard',
    name: 'Standard',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
  },
  {
    id: 'audiobookshelf',
    name: 'Audiobookshelf',
    folderFormat: '{author}/{series?/}{title}',
    fileFormat: '{title}',
  },
  {
    id: 'plex',
    name: 'Plex',
    folderFormat: '{author}/{series?/}{year? - }{title}',
    fileFormat: '{title}{ - pt?trackNumber:00}',
  },
  {
    id: 'last-first',
    name: 'Last, First',
    folderFormat: '{authorLastFirst}/{titleSort}',
    fileFormat: '{authorLastFirst} - {titleSort}',
  },
] as const;

/** Detect which preset matches the given folder/file formats, or return 'custom'. */
export function detectPreset(folderFormat: string, fileFormat: string): string {
  const match = NAMING_PRESETS.find(
    (p) => p.folderFormat === folderFormat && p.fileFormat === fileFormat,
  );
  return match?.id ?? 'custom';
}
