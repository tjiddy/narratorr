import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { SearchSettingsSection } from './SearchSettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

function Wrapper({ children }: { children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode }) {
  const methods = useForm<UpdateSettingsFormData>({
    defaultValues: {
      search: { enabled: false, intervalMinutes: 360 },
      library: { path: '', folderFormat: '' },
      import: { deleteAfterImport: false, minSeedTime: 60 },
      general: { logLevel: 'info' },
      metadata: { audibleRegion: 'us' },
    },
  });
  return <FormProvider {...methods}>{children(methods)}</FormProvider>;
}

describe('SearchSettingsSection', () => {
  it('renders search fields without auto-grab toggle', async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    expect(screen.getByText('Search Interval (minutes)')).toBeInTheDocument();
    // Auto-grab toggle should not exist — grabbing is always part of searching
    expect(screen.queryByText('Auto-Grab Best Result')).not.toBeInTheDocument();

    const checkbox = screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('allows changing the search interval', async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    const intervalInput = screen.getByPlaceholderText('360');
    await user.clear(intervalInput);
    await user.type(intervalInput, '120');
    expect(intervalInput).toHaveValue(120);
  });

  it('describes that search includes grabbing', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText(/grab the best result/)).toBeInTheDocument();
  });
});
