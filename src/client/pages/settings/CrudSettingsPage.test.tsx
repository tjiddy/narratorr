import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CrudSettingsPage } from './CrudSettingsPage';
import type { CrudSettingsConfig } from '@/hooks/useCrudSettings';
import { useCrudSettings } from '@/hooks/useCrudSettings';

vi.mock('@/hooks/useCrudSettings', () => ({
  useCrudSettings: vi.fn(),
}));

const mockUseCrudSettings = useCrudSettings as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock factory; full UseMutationResult typing adds noise without value
function createMockHookReturn(overrides: Record<string, any> = {}) {
  return {
    state: {
      items: [] as { id: number; name: string }[],
      isLoading: false,
      showForm: false,
      editingId: null,
      deleteTarget: null,
      ...overrides.state,
    },
    actions: {
      setDeleteTarget: vi.fn(),
      handleToggleForm: vi.fn(),
      handleEdit: vi.fn(),
      handleCancelEdit: vi.fn(),
      ...overrides.actions,
    },
    mutations: {
      createMutation: { mutate: vi.fn(), isPending: false },
      updateMutation: { mutate: vi.fn(), isPending: false },
      deleteMutation: { mutate: vi.fn(), isPending: false },
      ...overrides.mutations,
    },
    tests: {
      testingId: null,
      testResult: null,
      testingForm: false,
      formTestResult: null,
      handleTest: vi.fn(),
      handleFormTest: vi.fn(),
      clearFormTestResult: vi.fn(),
      ...overrides.tests,
    },
  };
}

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

const baseProps = {
  config: baseConfig,
  icon: <span data-testid="icon" />,
  title: 'Widgets',
  subtitle: 'Manage widgets',
  addLabel: 'Add Widget',
  emptyIcon: <span data-testid="empty-icon" />,
  emptyTitle: 'No widgets',
  emptySubtitle: 'Add one',
  deleteTitle: 'Delete widget',
  renderCard: vi.fn(() => null),
  renderForm: vi.fn(() => <div data-testid="add-form">Form</div>),
};

describe('CrudSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCrudSettings.mockReturnValue(createMockHookReturn());
  });

  it('renders headerExtra alongside the action button when provided', () => {
    render(
      <CrudSettingsPage
        {...baseProps}
        headerExtra={<button type="button">Import</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Import' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add Widget' })).toBeDefined();
  });

  it('does not render extra header content when headerExtra is not provided', () => {
    render(<CrudSettingsPage {...baseProps} />);

    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Widget' })).toBeDefined();
  });

  describe('add button / cancel toggle', () => {
    it('clicking add button calls handleToggleForm', async () => {
      const mockReturn = createMockHookReturn();
      mockUseCrudSettings.mockReturnValue(mockReturn);
      const user = userEvent.setup();
      render(<CrudSettingsPage {...baseProps} />);

      await user.click(screen.getByRole('button', { name: 'Add Widget' }));
      expect(mockReturn.actions.handleToggleForm).toHaveBeenCalledOnce();
    });

    it('button text shows addLabel when form is closed', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: false } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.getByRole('button', { name: 'Add Widget' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('header button shows addLabel text and is disabled when form is open', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      render(<CrudSettingsPage {...baseProps} />);

      const addButton = screen.getByRole('button', { name: 'Add Widget' });
      expect(addButton).toBeDefined();
      expect(addButton).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('header button is enabled when form is closed', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: false } }));
      render(<CrudSettingsPage {...baseProps} />);

      const addButton = screen.getByRole('button', { name: 'Add Widget' });
      expect(addButton).toBeDefined();
      expect(addButton).not.toBeDisabled();
    });
  });

  describe('form rendering', () => {
    it('renders form when showForm is true', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.getByTestId('add-form')).toBeDefined();
    });

    it('does not render form when showForm is false', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: false } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.queryByTestId('add-form')).toBeNull();
    });

    it('passes handleToggleForm as onCancel to renderForm', () => {
      const handleToggleForm = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { showForm: true },
        actions: { handleToggleForm },
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture handlers from mock call
      let capturedHandlers: any;
      const renderForm = vi.fn((handlers: unknown) => { capturedHandlers = handlers; return null; });
      render(<CrudSettingsPage {...baseProps} renderForm={renderForm} />);

      expect(renderForm).toHaveBeenCalledOnce();
      capturedHandlers.onCancel();
      expect(handleToggleForm).toHaveBeenCalledOnce();
    });

    it('passes createMutation.mutate as onSubmit to renderForm', () => {
      const createMutate = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { showForm: true },
        mutations: { createMutation: { mutate: createMutate, isPending: false } },
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture handlers from mock call
      let capturedHandlers: any;
      const renderForm = vi.fn((handlers: unknown) => { capturedHandlers = handlers; return null; });
      render(<CrudSettingsPage {...baseProps} renderForm={renderForm} />);

      expect(renderForm).toHaveBeenCalledOnce();
      capturedHandlers.onSubmit({ name: 'test' });
      expect(createMutate).toHaveBeenCalledWith({ name: 'test' });
    });
  });

  describe('loading state', () => {
    it('shows loading spinner when isLoading is true', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { isLoading: true } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.getByTestId('loading-spinner')).toBeDefined();
    });

    it('does not show empty state or items when loading', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { isLoading: true } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.queryByText('No widgets')).toBeNull();
      expect(baseProps.renderCard).not.toHaveBeenCalled();
    });
  });

  describe('empty state', () => {
    it('shows empty state when items is empty and not loading', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items: [], isLoading: false } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.getByText('No widgets')).toBeDefined();
      expect(screen.getByText('Add one')).toBeDefined();
    });

    it('renders emptyTitle and emptySubtitle text', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn());
      render(<CrudSettingsPage {...baseProps} emptyTitle="Nothing here" emptySubtitle="Create something" />);

      expect(screen.getByText('Nothing here')).toBeDefined();
      expect(screen.getByText('Create something')).toBeDefined();
    });
  });

  describe('card rendering', () => {
    const items = [
      { id: 1, name: 'Widget A' },
      { id: 2, name: 'Widget B' },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture render callback args from mock
    function createCapturingRenderCard(): { fn: typeof baseProps.renderCard; calls: Array<{ item: any; handlers: any }> } {
      const calls: Array<{ item: unknown; handlers: unknown }> = [];
      const fn = vi.fn((item: unknown, handlers: unknown) => {
        calls.push({ item, handlers });
        return null;
      });
      return { fn: fn as typeof baseProps.renderCard, calls };
    }

    it('calls renderCard for each item', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items } }));
      const { fn: renderCard, calls } = createCapturingRenderCard();
      render(<CrudSettingsPage {...baseProps} renderCard={renderCard} />);

      expect(renderCard).toHaveBeenCalledTimes(2);
      expect(calls[0]!.item).toEqual({ id: 1, name: 'Widget A' });
      expect(calls[1]!.item).toEqual({ id: 2, name: 'Widget B' });
    });

    it('passes mode "edit" when editingId matches item id', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items, editingId: 1 } }));
      const { fn: renderCard, calls } = createCapturingRenderCard();
      render(<CrudSettingsPage {...baseProps} renderCard={renderCard} />);

      expect(calls[0]!.handlers.mode).toBe('edit');
      expect(calls[1]!.handlers.mode).toBe('view');
    });

    it('passes mode "view" when editingId does not match item id', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items, editingId: null } }));
      const { fn: renderCard, calls } = createCapturingRenderCard();
      render(<CrudSettingsPage {...baseProps} renderCard={renderCard} />);

      expect(calls[0]!.handlers.mode).toBe('view');
      expect(calls[1]!.handlers.mode).toBe('view');
    });

    it('onSubmit wraps payload as { id, data } for updateMutation', () => {
      const updateMutate = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { items },
        mutations: { updateMutation: { mutate: updateMutate, isPending: false } },
      }));
      const { fn: renderCard, calls } = createCapturingRenderCard();
      render(<CrudSettingsPage {...baseProps} renderCard={renderCard} />);

      calls[0]!.handlers.onSubmit({ name: 'updated' });
      expect(updateMutate).toHaveBeenCalledWith({ id: 1, data: { name: 'updated' } });
    });

    it('onDelete sets deleteTarget to the item', () => {
      const setDeleteTarget = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { items },
        actions: { setDeleteTarget },
      }));
      const { fn: renderCard, calls } = createCapturingRenderCard();
      render(<CrudSettingsPage {...baseProps} renderCard={renderCard} />);

      calls[0]!.handlers.onDelete();
      expect(setDeleteTarget).toHaveBeenCalledWith({ id: 1, name: 'Widget A' });
    });
  });

  describe('modal mode', () => {
    const modalProps = { ...baseProps, modal: true as const };

    it('clicking add button opens modal with create form when modal prop is true', async () => {
      const handleToggleForm = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        actions: { handleToggleForm },
      }));
      const user = userEvent.setup();
      render(<CrudSettingsPage {...modalProps} />);

      await user.click(screen.getByRole('button', { name: 'Add Widget' }));
      expect(handleToggleForm).toHaveBeenCalledOnce();
    });

    it('renders form inside modal portal when showForm is true and modal is enabled', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      render(<CrudSettingsPage {...modalProps} />);

      // Modal portals to body — look for the modal backdrop
      expect(screen.getByTestId('modal-backdrop')).toBeDefined();
      expect(screen.getByTestId('add-form')).toBeDefined();
    });

    it('does not render form inline when showForm is true and modal is enabled', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      const { container } = render(<CrudSettingsPage {...modalProps} />);

      // Form should NOT be inside the main container (it's in a portal)
      const mainDiv = container.firstElementChild!;
      expect(mainDiv.querySelector('[data-testid="add-form"]')).toBeNull();
    });

    it('renders edit form inside modal when editingId is set and modal is enabled', () => {
      const items = [{ id: 1, name: 'Widget A' }];
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items, editingId: 1 } }));
      const renderCard = vi.fn((_: unknown, handlers: { mode: string }) => {
        if (handlers.mode === 'edit') return <div data-testid="edit-form">Edit Form</div>;
        return <div data-testid="view-card">View Card</div>;
      });
      render(<CrudSettingsPage {...modalProps} renderCard={renderCard} />);

      expect(screen.getByTestId('modal-backdrop')).toBeDefined();
      expect(screen.getByTestId('edit-form')).toBeDefined();
    });

    it('header add button stays enabled in modal mode even when form is showing', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      render(<CrudSettingsPage {...modalProps} />);

      const addButton = screen.getByRole('button', { name: 'Add Widget' });
      expect(addButton).not.toBeDisabled();
    });

    it('modal closes when backdrop clicked and no mutation is pending', async () => {
      const handleToggleForm = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { showForm: true },
        actions: { handleToggleForm },
      }));
      const user = userEvent.setup();
      render(<CrudSettingsPage {...modalProps} />);

      await user.click(screen.getByTestId('modal-backdrop'));
      expect(handleToggleForm).toHaveBeenCalledOnce();
    });

    it('modal does NOT close when backdrop clicked and create mutation is pending', async () => {
      const handleToggleForm = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { showForm: true },
        actions: { handleToggleForm },
        mutations: { createMutation: { mutate: vi.fn(), isPending: true } },
      }));
      const user = userEvent.setup();
      render(<CrudSettingsPage {...modalProps} />);

      await user.click(screen.getByTestId('modal-backdrop'));
      expect(handleToggleForm).not.toHaveBeenCalled();
    });

    it('modal closes when Escape pressed and no mutation is pending', () => {
      const handleToggleForm = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { showForm: true },
        actions: { handleToggleForm },
      }));
      render(<CrudSettingsPage {...modalProps} />);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      expect(handleToggleForm).toHaveBeenCalledOnce();
    });

    it('modal does NOT close when Escape pressed and create mutation is pending', () => {
      const handleToggleForm = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { showForm: true },
        actions: { handleToggleForm },
        mutations: { createMutation: { mutate: vi.fn(), isPending: true } },
      }));
      render(<CrudSettingsPage {...modalProps} />);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      expect(handleToggleForm).not.toHaveBeenCalled();
    });

    it('modal does NOT close when Escape pressed and update mutation is pending', () => {
      const items = [{ id: 1, name: 'Widget A' }];
      const handleCancelEdit = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { items, editingId: 1 },
        actions: { handleCancelEdit },
        mutations: { updateMutation: { mutate: vi.fn(), isPending: true } },
      }));
      render(<CrudSettingsPage {...modalProps} renderCard={vi.fn(() => <div>edit</div>)} />);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      expect(handleCancelEdit).not.toHaveBeenCalled();
    });

    it('cards in list render in view mode even when editingId is set in modal mode', () => {
      const items = [{ id: 1, name: 'Widget A' }, { id: 2, name: 'Widget B' }];
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items, editingId: 1 } }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture render callback args
      const capturedModes: string[] = [];
      const renderCard = vi.fn((_: unknown, handlers: { mode: string }) => {
        capturedModes.push(handlers.mode);
        return <div>Card</div>;
      });
      render(<CrudSettingsPage {...modalProps} renderCard={renderCard} />);

      // In modal mode, cards in the list should always be 'view' — edit renders in the modal
      // renderCard is called 3 times: 2 for list (view) + 1 for modal edit
      const listModes = capturedModes.slice(0, 2);
      expect(listModes).toEqual(['view', 'view']);
    });

    it('passes inModal=true to renderForm handlers in modal mode', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture handlers
      let capturedHandlers: any;
      const renderForm = vi.fn((handlers: unknown) => { capturedHandlers = handlers; return <div data-testid="add-form">Form</div>; });
      render(<CrudSettingsPage {...modalProps} renderForm={renderForm} />);

      expect(capturedHandlers.inModal).toBe(true);
    });

    it('passes inModal=false to renderForm handlers in inline mode', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture handlers
      let capturedHandlers: any;
      const renderForm = vi.fn((handlers: unknown) => { capturedHandlers = handlers; return <div data-testid="add-form">Form</div>; });
      render(<CrudSettingsPage {...baseProps} renderForm={renderForm} />);

      expect(capturedHandlers.inModal).toBe(false);
    });

    it('does not render modal when modal prop is false (inline behavior preserved)', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.queryByTestId('modal-backdrop')).toBeNull();
      expect(screen.getByTestId('add-form')).toBeDefined();
    });
  });

  describe('modal mode — NotificationsSettings regression', () => {
    it('CrudSettingsPage without modal prop still renders inline form', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { showForm: true } }));
      const { container } = render(<CrudSettingsPage {...baseProps} />);

      // Form should be inside the main container (inline, not portaled)
      const mainDiv = container.firstElementChild!;
      expect(mainDiv.querySelector('[data-testid="add-form"]')).not.toBeNull();
    });

    it('CrudSettingsPage without modal prop still supports inline edit mode', () => {
      const items = [{ id: 1, name: 'Widget A' }];
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({ state: { items, editingId: 1 } }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capture render callback args
      let capturedMode: any;
      const renderCard = vi.fn((_: unknown, handlers: { mode: string }) => {
        capturedMode = handlers.mode;
        return <div data-testid="card">Card</div>;
      });
      render(<CrudSettingsPage {...baseProps} renderCard={renderCard} />);

      expect(capturedMode).toBe('edit');
      expect(screen.queryByTestId('modal-backdrop')).toBeNull();
    });
  });

  describe('delete modal', () => {
    it('opens confirmation modal when deleteTarget is set', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { deleteTarget: { id: 1, name: 'Widget A' } },
      }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('modal message includes deleteTarget name', () => {
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { deleteTarget: { id: 1, name: 'Widget A' } },
      }));
      render(<CrudSettingsPage {...baseProps} />);

      expect(screen.getByText(/Widget A/)).toBeDefined();
      expect(screen.getByText(/Are you sure you want to delete/)).toBeDefined();
    });

    it('confirming calls deleteMutation.mutate with item id and clears deleteTarget', async () => {
      const deleteMutate = vi.fn();
      const setDeleteTarget = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { deleteTarget: { id: 1, name: 'Widget A' } },
        actions: { setDeleteTarget },
        mutations: { deleteMutation: { mutate: deleteMutate, isPending: false } },
      }));
      const user = userEvent.setup();
      render(<CrudSettingsPage {...baseProps} />);

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      expect(deleteMutate).toHaveBeenCalledWith(1);
      expect(setDeleteTarget).toHaveBeenCalledWith(null);
    });

    it('cancelling clears deleteTarget without calling mutation', async () => {
      const deleteMutate = vi.fn();
      const setDeleteTarget = vi.fn();
      mockUseCrudSettings.mockReturnValue(createMockHookReturn({
        state: { deleteTarget: { id: 1, name: 'Widget A' } },
        actions: { setDeleteTarget },
        mutations: { deleteMutation: { mutate: deleteMutate, isPending: false } },
      }));
      const user = userEvent.setup();
      render(<CrudSettingsPage {...baseProps} />);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(setDeleteTarget).toHaveBeenCalledWith(null);
      expect(deleteMutate).not.toHaveBeenCalled();
    });
  });
});
