/**
 * Stable import barrel for EPUB fixtures. Book fixtures may depend on ZIP fixtures,
 * never the reverse, because re-exporting both would close a cycle. Export names must
 * remain disjoint.
 */
export * from './epub-zip.fixture.js';
export * from './epub-book.fixture.js';
