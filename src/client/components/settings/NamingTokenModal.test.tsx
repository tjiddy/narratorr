import { describe, it } from 'vitest';

describe('NamingTokenModal', () => {
  describe('folder-scoped modal', () => {
    it.todo('shows Author, Title, Series, Narrator, Metadata groups');
    it.todo('does not show File-specific group');
    it.todo('shows correct tokens per group — Author (2), Title (2), Series (2), Narrator (2), Metadata (1)');
  });

  describe('file-scoped modal', () => {
    it.todo('shows all groups including File-specific');
    it.todo('shows File-specific tokens: trackNumber, trackTotal, partName');
  });

  describe('token insertion', () => {
    it.todo('calls onInsert with token name when token row is clicked');
  });

  describe('syntax reference', () => {
    it.todo('shows {token}, {token:00}, and {token? text} syntax examples');
    it.todo('shows "Good to know" section with space collapsing, illegal chars, 255-char notes');
  });

  describe('live preview', () => {
    it.todo('footer shows rendered preview of current format value');
  });

  describe('close behavior', () => {
    it.todo('closes when X button is clicked');
    it.todo('closes when backdrop is clicked');
    it.todo('calls onClose callback');
  });
});
