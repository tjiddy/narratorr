import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsRow, SettingsTable } from './SettingsRow';

describe('SettingsRow', () => {
  describe('row layout (default)', () => {
    it('renders label, description, and control with htmlFor association', () => {
      render(
        <SettingsRow htmlFor="field" label="My setting" description="What it does">
          <input id="field" type="text" />
        </SettingsRow>
      );
      expect(screen.getByText('What it does')).toBeInTheDocument();
      // htmlFor/id association: the row label resolves to the control.
      expect(screen.getByLabelText('My setting')).toBeInTheDocument();
    });

    it('renders no description node when description is omitted', () => {
      const { container } = render(
        <SettingsRow htmlFor="field" label="My setting">
          <input id="field" type="text" />
        </SettingsRow>
      );
      expect(container.querySelector('p')).toBeNull();
    });

    it('dims the header block when muted', () => {
      render(
        <SettingsRow htmlFor="field" label="My setting" description="What it does" muted>
          <input id="field" type="text" />
        </SettingsRow>
      );
      expect(screen.getByText('My setting').closest('div')).toHaveClass('opacity-50');
    });
  });

  describe('stacked layout', () => {
    it('renders label, description, and control with htmlFor association', () => {
      render(
        <SettingsRow layout="stacked" htmlFor="field" label="My setting" description="What it does">
          <input id="field" type="text" />
        </SettingsRow>
      );
      expect(screen.getByText('What it does')).toBeInTheDocument();
      expect(screen.getByLabelText('My setting')).toBeInTheDocument();
    });

    it('places the control below the header, not beside it', () => {
      render(
        <SettingsRow layout="stacked" htmlFor="field" label="My setting">
          <input id="field" type="text" />
        </SettingsRow>
      );
      const control = screen.getByLabelText('My setting');
      // Stacked: control lives in an mt-3 block under the header (row layout uses shrink-0 beside it).
      expect(control.closest('div.mt-3')).not.toBeNull();
      expect(control.closest('div.shrink-0')).toBeNull();
    });

    it('dims the header block when muted', () => {
      render(
        <SettingsRow layout="stacked" htmlFor="field" label="My setting" muted>
          <input id="field" type="text" />
        </SettingsRow>
      );
      expect(screen.getByText('My setting').closest('div')).toHaveClass('opacity-50');
    });
  });

  describe('header element', () => {
    it('renders a <label> when htmlFor is provided', () => {
      render(
        <SettingsRow htmlFor="field" label="My setting">
          <input id="field" type="text" />
        </SettingsRow>
      );
      expect(screen.getByText('My setting').tagName).toBe('LABEL');
    });

    it('renders a <span> when htmlFor is absent (group content has no single control to label)', () => {
      render(
        <SettingsRow label="Languages">
          <div role="group">many checkboxes</div>
        </SettingsRow>
      );
      expect(screen.getByText('Languages').tagName).toBe('SPAN');
    });
  });
});

describe('SettingsTable', () => {
  it('renders children inside the bordered, divided container', () => {
    render(
      <SettingsTable>
        <SettingsRow htmlFor="a" label="Row A"><input id="a" /></SettingsRow>
        <SettingsRow htmlFor="b" label="Row B"><input id="b" /></SettingsRow>
      </SettingsTable>
    );
    const table = screen.getByText('Row A').closest('div.divide-y');
    expect(table).not.toBeNull();
    expect(table).toContainElement(screen.getByText('Row B'));
  });
});
