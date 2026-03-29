import { describe, it } from 'vitest';

describe('NAMING_PRESETS', () => {
  it.todo('contains Standard preset with correct folderFormat and fileFormat');
  it.todo('contains Audiobookshelf preset with correct folderFormat and fileFormat');
  it.todo('contains Plex preset with correct folderFormat and fileFormat');
  it.todo('contains "Last, First" preset with correct folderFormat and fileFormat');
  it.todo('has exactly 4 presets');
});

describe('detectPreset', () => {
  it.todo('returns preset id when both fields match a defined preset');
  it.todo('returns "custom" when only folderFormat matches');
  it.todo('returns "custom" when only fileFormat matches');
  it.todo('returns "custom" when neither field matches any preset');
});
