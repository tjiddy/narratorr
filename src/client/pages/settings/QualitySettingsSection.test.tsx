import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { QualitySettingsSection } from './QualitySettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

function TestWrapper({ defaultValues }: { defaultValues?: Partial<UpdateSettingsFormData> }) {
  const methods = useForm<UpdateSettingsFormData>({
    defaultValues: {
      quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
      ...defaultValues,
    },
  });
  return (
    <FormProvider {...methods}>
      <form>
        <QualitySettingsSection register={methods.register} errors={methods.formState.errors} />
      </form>
    </FormProvider>
  );
}

describe('QualitySettingsSection', () => {
  it('renders section title "Quality"', () => {
    render(<TestWrapper />);
    expect(screen.getByText('Quality')).toBeInTheDocument();
  });

  it('renders all form fields', () => {
    render(<TestWrapper />);

    expect(screen.getByLabelText('MB/hr Grab Floor')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol Preference')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum Seeders')).toBeInTheDocument();
    expect(screen.getByLabelText('Reject Words')).toBeInTheDocument();
    expect(screen.getByLabelText('Required Words')).toBeInTheDocument();
    expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    expect(screen.getByLabelText('Monitor for Upgrades')).toBeInTheDocument();
  });

  it('renders description text for each field', () => {
    render(<TestWrapper />);

    expect(screen.getByText(/Minimum MB\/hr to accept/)).toBeInTheDocument();
    expect(screen.getByText(/Preferred download protocol/)).toBeInTheDocument();
    expect(screen.getByText(/Torrent results with fewer seeders/)).toBeInTheDocument();
    expect(screen.getByText(/Releases with titles matching any word are excluded/)).toBeInTheDocument();
    expect(screen.getByText(/only releases with titles matching at least one word/)).toBeInTheDocument();
    expect(screen.getByText(/Trigger a search as soon as a book is added/)).toBeInTheDocument();
    expect(screen.getByText(/Include new books in scheduled upgrade searches/)).toBeInTheDocument();
  });

  it('protocol preference select has all three options', () => {
    render(<TestWrapper />);

    const select = screen.getByLabelText('Protocol Preference');
    const options = select.querySelectorAll('option');

    expect(options).toHaveLength(3);
    expect(screen.getByText('No Preference')).toBeInTheDocument();
    expect(screen.getByText('Prefer Usenet')).toBeInTheDocument();
    expect(screen.getByText('Prefer Torrent')).toBeInTheDocument();
  });

  it('grab floor accepts numeric input', async () => {
    const user = userEvent.setup();
    render(<TestWrapper />);

    const input = screen.getByLabelText('MB/hr Grab Floor');
    await user.clear(input);
    await user.type(input, '150');
    expect(input).toHaveValue(150);
  });

  it('renders reject words text input with placeholder', () => {
    render(<TestWrapper />);
    const input = screen.getByLabelText('Reject Words');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'German, Abridged, Full Cast, Dramatized');
  });

  it('renders required words text input with placeholder', () => {
    render(<TestWrapper />);
    const input = screen.getByLabelText('Required Words');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'M4B, Unabridged');
  });

  it('accepts text input for word lists', async () => {
    const user = userEvent.setup();
    render(<TestWrapper />);

    const rejectInput = screen.getByLabelText('Reject Words');
    await user.type(rejectInput, 'German, Abridged');
    expect(rejectInput).toHaveValue('German, Abridged');

    const requiredInput = screen.getByLabelText('Required Words');
    await user.type(requiredInput, 'M4B');
    expect(requiredInput).toHaveValue('M4B');
  });

  it('min seeders accepts numeric input', async () => {
    const user = userEvent.setup();
    render(<TestWrapper />);

    const input = screen.getByLabelText('Minimum Seeders');
    await user.clear(input);
    await user.type(input, '5');
    expect(input).toHaveValue(5);
  });
});
