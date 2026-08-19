import { toLastFirst, toSortTitle } from '@core/utils/index.js';

// Baseline samples omit edition; only edition-specific previews add this discriminator.
export const SAMPLE_EDITION = 'Full Cast';

export const SAMPLE_TOKENS = {
  author: 'Brandon Sanderson', authorLastFirst: toLastFirst('Brandon Sanderson'),
  title: 'The Way of Kings', titleSort: toSortTitle('The Way of Kings'),
  series: 'The Stormlight Archive', seriesPosition: 1, year: '2010',
  narrator: 'Michael Kramer, Kate Reading', narratorLastFirst: toLastFirst('Michael Kramer, Kate Reading'),
};

export const SAMPLE_TOKENS_NO_SERIES = {
  author: 'Andy Weir', authorLastFirst: toLastFirst('Andy Weir'),
  title: 'Project Hail Mary', titleSort: toSortTitle('Project Hail Mary'),
  year: '2021', narrator: 'Ray Porter', narratorLastFirst: toLastFirst('Ray Porter'),
};

export const SAMPLE_TOKENS_MULTIFILE = {
  ...SAMPLE_TOKENS,
  trackNumber: 3, trackTotal: 12, partName: 'Chapter 3',
};

// The file preview's own sample: one track of a multi-file book, edition included so an
// inserted {edition} renders.
export const SAMPLE_TOKENS_FILE_MODAL = {
  ...SAMPLE_TOKENS, edition: SAMPLE_EDITION, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings',
};

export const SAMPLE_TOKENS_FOLDER_MODAL = { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION };
