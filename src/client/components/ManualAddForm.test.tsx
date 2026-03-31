import { describe, it } from 'vitest';

describe('ManualAddForm', () => {
  describe('form validation', () => {
    it.todo('shows validation error when title is empty on submit');
    it.todo('shows validation error when title is whitespace-only on submit');
    it.todo('trims title before submission');
    it.todo('submits successfully with title only');
    it.todo('submits successfully with all fields populated');
    it.todo('series position accepts numeric values');
    it.todo('series position rejects non-numeric input');
  });

  describe('pre-fill behavior', () => {
    it.todo('pre-fills title from defaultTitle prop');
    it.todo('allows editing pre-filled title before submission');
    it.todo('renders empty title when no defaultTitle prop');
  });

  describe('mutation lifecycle', () => {
    it.todo('disables Add button while mutation is pending');
    it.todo('shows success toast after successful add');
    it.todo('invalidates books query after successful add');
    it.todo('shows error toast when API returns error');
    it.todo('resets form after successful submission');
  });
});
