import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import { SettingsSection } from './SettingsSection';

describe('SettingsSection', () => {
  it('renders title, description, and children', () => {
    render(
      <SettingsSection
        icon={<span data-testid="test-icon">icon</span>}
        title="Test Section"
        description="A test description"
      >
        <p>Child content</p>
      </SettingsSection>,
    );

    expect(screen.getByText('Test Section')).toBeInTheDocument();
    expect(screen.getByText('A test description')).toBeInTheDocument();
    expect(screen.getByText('Child content')).toBeInTheDocument();
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });
});
