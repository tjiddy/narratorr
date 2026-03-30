import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { renderWithProviders } from '@/__tests__/helpers';
import { NotifierCardForm } from './NotifierCardForm';
import type { CreateNotifierFormData } from '../../../shared/schemas.js';

function NotifierCardFormWrapper({ onSubmit = vi.fn(), injectTypeError = false }: { onSubmit?: (data: CreateNotifierFormData) => void; injectTypeError?: boolean }) {
  const form = useForm<CreateNotifierFormData>({
    defaultValues: {
      name: '',
      type: 'webhook',
      enabled: true,
      events: ['on_grab'],
      settings: { webhookUrl: '', method: 'POST' },
    },
  });
  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = form.watch('type');
  const watchedEvents = form.watch('events') ?? [];

  useEffect(() => {
    if (injectTypeError) {
      form.setError('type', { type: 'validate', message: 'Invalid type' });
    }
  }, [injectTypeError, form]);

  return (
    <NotifierCardForm
      form={form}
      isEdit={false}
      selectedType={selectedType}
      watchedEvents={watchedEvents}
      onSubmit={onSubmit}
      onFormTest={vi.fn()}
      onEventToggle={vi.fn()}
    />
  );
}

describe('NotifierCardForm (#224)', () => {
  describe('SelectWithChevron migration', () => {
    it('type select renders with appearance-none and ChevronDownIcon', () => {
      renderWithProviders(<NotifierCardFormWrapper />);

      const select = screen.getByLabelText('Type');
      expect(select.className).toContain('appearance-none');
      const selectParent = select.parentElement!;
      expect(selectParent.querySelector('svg')).not.toBeNull();
    });

    it('selecting a notifier type via SelectWithChevron updates form state', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotifierCardFormWrapper />);

      await user.selectOptions(screen.getByLabelText('Type'), 'telegram');
      expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('telegram');
    });

    it('type select shows border-destructive when errors.type is present', async () => {
      renderWithProviders(<NotifierCardFormWrapper injectTypeError />);

      await waitFor(() => {
        const select = screen.getByLabelText('Type');
        expect(select.className).toContain('border-destructive');
        expect(select.className).not.toContain('border-border');
      });
    });

    it('type select shows border-border when no type error exists', () => {
      renderWithProviders(<NotifierCardFormWrapper />);

      const select = screen.getByLabelText('Type');
      expect(select.className).toContain('border-border');
      expect(select.className).not.toContain('border-destructive');
    });
  });
});
