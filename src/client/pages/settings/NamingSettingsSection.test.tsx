import { describe, it } from 'vitest';

describe('NamingSettingsSection', () => {
  describe('rendering', () => {
    it.todo('renders with TagIcon, title "File Naming", and description text');
    it.todo('manages its own independent useForm — does not share form context with LibrarySettingsSection');
    it.todo('renders Folder Format field full-width with ? button');
    it.todo('renders File Format field below Folder Format, same layout');
    it.todo('renders per-field preview with with-series and without-series examples below each format field');
    it.todo('? buttons have cursor-pointer class');
  });

  describe('preset interaction', () => {
    it.todo('changing preset updates both format fields');
    it.todo('manual format edit changes preset to Custom');
  });

  describe('separator and case', () => {
    it.todo('separator dropdown updates preview rendering');
    it.todo('case dropdown updates preview rendering');
    it.todo('select dropdowns use px-4 py-3 padding and appearance-none with custom chevron');
  });

  describe('format field editing', () => {
    it.todo('editing folder format updates folder preview only, not file preview');
    it.todo('editing file format updates file preview only, not folder preview');
    it.todo('clicking ? button opens NamingTokenModal for the correct scope');
    it.todo('inserting token from modal updates the format field');
  });

  describe('form submission', () => {
    it.todo('saves all naming fields to library settings category');
    it.todo('shows save button only when form is dirty');
    it.todo('resets form after successful save');
    it.todo('shows error toast on save failure');
  });

  describe('validation', () => {
    it.todo('shows error for folder format without {title} token');
    it.todo('shows error for file format without {title} token');
  });

  describe('label type tightening', () => {
    it.todo('SEPARATOR_LABELS typed as Record<NamingSeparator, string>');
    it.todo('CASE_LABELS typed as Record<NamingCase, string>');
  });
});
