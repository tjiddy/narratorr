import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CrudSettingsPage } from './CrudSettingsPage';
import type { CrudSettingsConfig } from '@/hooks/useCrudSettings';

vi.mock('@/hooks/useCrudSettings', () => ({
  useCrudSettings: vi.fn().mockReturnValue({
    items: [],
    isLoading: false,
    showForm: false,
    editingId: null,
    deleteTarget: null,
    setDeleteTarget: vi.fn(),
    createMutation: { mutate: vi.fn(), isPending: false },
    updateMutation: { mutate: vi.fn(), isPending: false },
    deleteMutation: { mutate: vi.fn(), isPending: false },
    handleToggleForm: vi.fn(),
    handleEdit: vi.fn(),
    handleCancelEdit: vi.fn(),
    testingId: null,
    testResult: null,
    testingForm: false,
    formTestResult: null,
    handleTest: vi.fn(),
    handleFormTest: vi.fn(),
  }),
}));

const baseConfig: CrudSettingsConfig<{ id: number; name: string }, unknown> = {
  queryKey: ['test'],
  queryFn: vi.fn(),
  createFn: vi.fn(),
  updateFn: vi.fn(),
  deleteFn: vi.fn(),
  testById: vi.fn(),
  testByConfig: vi.fn(),
  entityName: 'widget',
};

describe('CrudSettingsPage', () => {
  it('renders headerExtra alongside the action button when provided', () => {
    render(
      <CrudSettingsPage
        config={baseConfig}
        icon={<span data-testid="icon" />}
        title="Widgets"
        subtitle="Manage widgets"
        addLabel="Add Widget"
        emptyIcon={<span />}
        emptyTitle="No widgets"
        emptySubtitle="Add one"
        deleteTitle="Delete widget"
        headerExtra={<button type="button">Import</button>}
        renderCard={() => null}
        renderForm={() => null}
      />,
    );

    expect(screen.getByRole('button', { name: 'Import' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add Widget' })).toBeDefined();
  });

  it('does not render extra header content when headerExtra is not provided', () => {
    render(
      <CrudSettingsPage
        config={baseConfig}
        icon={<span data-testid="icon" />}
        title="Widgets"
        subtitle="Manage widgets"
        addLabel="Add Widget"
        emptyIcon={<span />}
        emptyTitle="No widgets"
        emptySubtitle="Add one"
        deleteTitle="Delete widget"
        renderCard={() => null}
        renderForm={() => null}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Widget' })).toBeDefined();
  });
});
