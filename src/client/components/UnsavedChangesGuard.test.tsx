import { useState } from 'react';
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';
import { useTrackedForm, _resetForTesting } from '@/hooks/dirty-forms';

// A minimal tracked "card" whose dirty/pending/label is controllable.
function TrackedCard({
  dirty = true,
  pending = false,
  label = 'Merge & Convert',
}: {
  dirty?: boolean;
  pending?: boolean;
  label?: string;
}) {
  useTrackedForm({ isDirty: dirty, isPending: pending, label });
  return null;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function currentPath(): string {
  return screen.getByTestId('location').textContent ?? '';
}

beforeEach(() => {
  _resetForTesting();
  vi.restoreAllMocks();
});

function renderGuard(ui: React.ReactNode, { initial = '/settings' } = {}) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <UnsavedChangesGuard />
      <LocationProbe />
      <Routes>
        <Route path="/settings" element={<>{ui}</>} />
        <Route path="/settings/indexers" element={<div>indexers page</div>} />
        <Route path="/library" element={<div>library page</div>} />
        <Route path="*" element={<div>other page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UnsavedChangesGuard', () => {
  it('lets a clean-form link click navigate with no modal', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard dirty={false} />
        <Link to="/settings/indexers">Indexers</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Indexers' }));
    expect(currentPath()).toBe('/settings/indexers');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('blocks a dirty-form link click and names the dirty card', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard label="Merge & Convert" />
        <Link to="/settings/indexers">Indexers</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Indexers' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Merge & Convert/)).toBeInTheDocument();
    // Navigation did not happen.
    expect(currentPath()).toBe('/settings');
  });

  it('names two dirty cards; cleaning one drops it from the list', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [secondDirty, setSecondDirty] = useState(true);
      return (
        <>
          <TrackedCard label="Housekeeping" />
          <TrackedCard label="Logging" dirty={secondDirty} />
          <Link to="/settings/indexers">Indexers</Link>
          <button type="button" onClick={() => setSecondDirty(false)}>
            clean-logging
          </button>
        </>
      );
    }
    renderGuard(<Harness />);
    await user.click(screen.getByRole('link', { name: 'Indexers' }));
    expect(screen.getByText(/Housekeeping, Logging/)).toBeInTheDocument();

    // Clean Logging while the modal is open → the name drops out.
    await user.click(screen.getByRole('button', { name: 'clean-logging' }));
    expect(screen.getByText(/Housekeeping/)).toBeInTheDocument();
    expect(screen.queryByText(/Logging/)).toBeNull();
  });

  it('Stay closes the modal and does not navigate', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard />
        <Link to="/settings/indexers">Indexers</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Indexers' }));
    await user.click(screen.getByRole('button', { name: 'Stay on page' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentPath()).toBe('/settings');
  });

  it('Discard replays the click and lands on the target (SPA Link)', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard />
        <Link to="/settings/indexers">Indexers</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Indexers' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(currentPath()).toBe('/settings/indexers');
  });

  it('Discard preserves query params on the target', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard />
        <Link to="/settings/indexers?edit=42">Edit indexer</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Edit indexer' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(currentPath()).toBe('/settings/indexers?edit=42');
  });

  it('Escape takes the Stay path (no navigation)', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard />
        <Link to="/settings/indexers">Indexers</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Indexers' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentPath()).toBe('/settings');
  });

  describe('event eligibility matrix', () => {
    async function clickAndExpectThrough(linkProps: Record<string, unknown>) {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <a href="/other" {...linkProps}>
            Ext
          </a>
        </>,
      );
      const link = screen.getByRole('link', { name: 'Ext' });
      // Prevent jsdom "Not implemented: navigation" noise for plain anchors.
      link.addEventListener('click', (e) => e.preventDefault());
      await user.click(link);
      // No modal → the guard let it through.
      return screen.queryByRole('dialog');
    }

    it('does not intercept target="_blank"', async () => {
      expect(await clickAndExpectThrough({ target: '_blank' })).toBeNull();
    });

    it('does not intercept target="_parent"', async () => {
      expect(await clickAndExpectThrough({ target: '_parent' })).toBeNull();
    });

    it('does not intercept a download link', async () => {
      expect(await clickAndExpectThrough({ download: '' })).toBeNull();
    });

    it('does not intercept a cross-origin link', async () => {
      expect(await clickAndExpectThrough({ href: 'https://example.com/x' })).toBeNull();
    });

    it('does not intercept a mixed-case named (non-_self) target', async () => {
      expect(await clickAndExpectThrough({ target: 'Report' })).toBeNull();
    });

    it('intercepts a mixed-case _SELF target (normalized, still guarded)', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers" target="_SELF">
            SelfLink
          </Link>
        </>,
      );
      await user.click(screen.getByRole('link', { name: 'SelfLink' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('does not intercept a modified (meta) click', async () => {
      const user = userEvent.setup({});
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers">Indexers</Link>
        </>,
      );
      const link = screen.getByRole('link', { name: 'Indexers' });
      await user.keyboard('{Meta>}');
      await user.click(link);
      await user.keyboard('{/Meta}');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('does not intercept a same-path click', async () => {
      // The same-path check compares the anchor's resolved pathname to
      // window.location.pathname (jsdom default "/"). A link resolving to "/"
      // is therefore a same-path no-op and must not be intercepted.
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/">Self</Link>
        </>,
      );
      const link = screen.getByRole('link', { name: 'Self' });
      await user.click(link);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('intercepts a click on a nested element inside a dirty Link', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers">
            <span data-testid="inner">Indexers</span>
          </Link>
        </>,
      );
      await user.click(screen.getByTestId('inner'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('stale / mutated captured target → safe-cancel', () => {
    it('captured Link unmounts before Discard → stays on page, both flags cleared', async () => {
      const user = userEvent.setup();
      function Harness() {
        const [show, setShow] = useState(true);
        return (
          <>
            <TrackedCard />
            {show && <Link to="/settings/indexers">Vanishing</Link>}
            <Link to="/library">Library</Link>
            <button type="button" onClick={() => setShow(false)}>
              hide
            </button>
          </>
        );
      }
      renderGuard(<Harness />);
      await user.click(screen.getByRole('link', { name: 'Vanishing' }));
      // Simulate the polling surface unmounting the captured node.
      await user.click(screen.getByRole('button', { name: 'hide' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      // Safe-cancel: stayed on the page, draft intact.
      expect(currentPath()).toBe('/settings');
      expect(screen.queryByRole('dialog')).toBeNull();

      // Both one-shot flags cleared: a subsequent genuine dirty click still guards.
      await user.click(screen.getByRole('link', { name: 'Library' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(currentPath()).toBe('/settings');
    });

    it('captured anchor href mutates before Discard → safe-cancel', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers">Mutant</Link>
        </>,
      );
      const link = screen.getByRole('link', { name: 'Mutant' });
      await user.click(link);
      // Mutate the captured node's href between interception and Discard.
      link.setAttribute('href', '/settings/indexers?edit=99');
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(currentPath()).toBe('/settings');
    });

    it('captured anchor gains a download attribute before Discard → safe-cancel', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers">Downloadable</Link>
        </>,
      );
      const link = screen.getByRole('link', { name: 'Downloadable' });
      await user.click(link);
      link.setAttribute('download', '');
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      // download presence changed → not replayed, stayed put.
      expect(currentPath()).toBe('/settings');
    });
  });

  describe('pending-save contract', () => {
    it('disables Discard while a tracked save is in flight', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard pending />
          <Link to="/settings/indexers">Indexers</Link>
        </>,
      );
      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      const discard = screen.getByRole('button', { name: 'Discard changes' });
      expect(discard).toBeDisabled();
    });

    it('closes the modal and stays when the form becomes clean while open', async () => {
      const user = userEvent.setup();
      function Harness() {
        const [dirty, setDirty] = useState(true);
        return (
          <>
            <TrackedCard dirty={dirty} />
            <Link to="/settings/indexers">Indexers</Link>
            <button type="button" onClick={() => setDirty(false)}>
              save
            </button>
          </>
        );
      }
      renderGuard(<Harness />);
      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'save' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');
    });
  });

  describe('beforeunload + suppression flag', () => {
    function dispatchBeforeunload(): boolean {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }

    // Card is a persistent sibling (not routed away) so it stays dirty across a
    // Discard navigation, letting us probe the flag decision afterward.
    function renderPersistent(ui: React.ReactNode, { dirty = true } = {}) {
      return render(
        <MemoryRouter initialEntries={['/settings']}>
          <UnsavedChangesGuard />
          <LocationProbe />
          <TrackedCard dirty={dirty} />
          {ui}
        </MemoryRouter>,
      );
    }

    it('prevents beforeunload while dirty, not while clean', () => {
      const { unmount } = renderPersistent(null, { dirty: true });
      expect(dispatchBeforeunload()).toBe(true);
      unmount();

      renderPersistent(null, { dirty: false });
      expect(dispatchBeforeunload()).toBe(false);
    });

    it('SPA-Link Discard leaves suppression unset (defaultPrevented === true)', async () => {
      const user = userEvent.setup();
      renderPersistent(<Link to="/settings/indexers">Indexers</Link>);
      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      // The replayed SPA click was preventDefault'd by Router → nothing to
      // suppress → the next beforeunload still prompts.
      expect(dispatchBeforeunload()).toBe(true);
    });

    it('plain-anchor Discard arms suppression for exactly one beforeunload', async () => {
      const user = userEvent.setup();
      renderPersistent(<a href="/library">Plain</a>);
      await user.click(screen.getByRole('link', { name: 'Plain' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      // The replayed plain-anchor click was NOT preventDefault'd (document
      // navigation) → suppression armed → this beforeunload is swallowed once.
      expect(dispatchBeforeunload()).toBe(false);
      // ...and cleared, so a later genuine dirty reload still prompts.
      expect(dispatchBeforeunload()).toBe(true);
    });
  });

  it('does not intercept programmatic navigate() (accepted hole, e.g. auth redirect)', async () => {
    const user = userEvent.setup();
    function NavButton() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate('/library')}>
          Go
        </button>
      );
    }
    renderGuard(
      <>
        <TrackedCard />
        <NavButton />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentPath()).toBe('/library');
  });

  describe('StrictMode', () => {
    it('registers a single active listener (one modal, one intercept)', async () => {
      const user = userEvent.setup();
      render(
        <StrictMode>
          <MemoryRouter initialEntries={['/settings']}>
            <UnsavedChangesGuard />
            <LocationProbe />
            <TrackedCard />
            <Link to="/settings/indexers">Indexers</Link>
          </MemoryRouter>
        </StrictMode>,
      );
      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      // Exactly one dialog even under StrictMode double-mount.
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });
  });
});
