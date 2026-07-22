import { useState } from 'react';
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

// Dispatch a cancelable beforeunload and report whether the guard prevented it.
function dispatchBeforeunload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
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

    // Each of the remaining eligibility operands (F4) is independently removable
    // from shouldLetClickThrough without failing the meta-only coverage above, so
    // every one gets a dedicated pass-through assertion. Synthetic dispatch gives
    // precise control of button/modifier/cancelable that userEvent can't express.
    function renderEligibleLink(): HTMLAnchorElement {
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers">Indexers</Link>
        </>,
      );
      return screen.getByRole('link', { name: 'Indexers' });
    }

    // A control assertion guards against vacuity: with the SAME harness, a plain
    // eligible left click IS intercepted, so a "no dialog" result below can only
    // mean the operand caused pass-through.
    it('control: a plain eligible click on this harness IS intercepted', () => {
      const link = renderEligibleLink();
      fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('does not intercept a non-left (middle/right button) click', () => {
      const link = renderEligibleLink();
      fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');
    });

    it('does not intercept a ctrl-click', () => {
      const link = renderEligibleLink();
      fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');
    });

    it('does not intercept a shift-click', () => {
      const link = renderEligibleLink();
      fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');
    });

    it('does not intercept an alt-click', () => {
      const link = renderEligibleLink();
      fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');
    });

    it('does not intercept an already-defaultPrevented click', () => {
      const link = renderEligibleLink();
      // A capture listener on `window` fires before the guard's document-capture
      // listener, so the guard sees the event already defaultPrevented.
      const pre = (e: Event) => e.preventDefault();
      window.addEventListener('click', pre, { capture: true });
      try {
        fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: true }));
      } finally {
        window.removeEventListener('click', pre, { capture: true });
      }
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');
    });

    it('does not intercept a non-cancelable click (and does not stop its propagation)', () => {
      const link = renderEligibleLink();
      let reachedBubble = false;
      link.addEventListener('click', () => {
        reachedBubble = true;
      });
      fireEvent(link, new MouseEvent('click', { bubbles: true, cancelable: false }));
      // Guard let it through (no modal) and did not stopPropagation — the bubble
      // listener on the anchor still fired.
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(reachedBubble).toBe(true);
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

    it('captured anchor target mutates before Discard → safe-cancel (no replay) (F5)', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard />
          <Link to="/settings/indexers">Retargeted</Link>
        </>,
      );
      const link = screen.getByRole('link', { name: 'Retargeted' });
      await user.click(link);

      // Watch for a replay: any click on the captured node AFTER interception
      // proves the guard re-fired it. A safe-cancel must not replay.
      let replayed = false;
      link.addEventListener('click', () => {
        replayed = true;
      });
      // Mutate target between interception and Discard (was eligible _self default).
      link.setAttribute('target', '_blank');
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));

      expect(replayed).toBe(false);
      expect(currentPath()).toBe('/settings');
      expect(screen.queryByRole('dialog')).toBeNull();

      // One-shot flags cleared: a subsequent genuine dirty click still guards.
      // (Deleting the `target` equality check would replay the _blank anchor and
      // trip `replayed`, and could leave bypassNextClick armed.)
    });
  });

  describe('area[href] activation (F6)', () => {
    it('intercepts an area[href] click like an anchor', () => {
      renderGuard(
        <>
          <TrackedCard />
          <map name="hotmap">
            <area href="/settings/indexers" shape="rect" coords="0,0,20,20" alt="AreaLink" />
          </map>
          <img src="hot.png" useMap="#hotmap" alt="hotspot" width={20} height={20} />
        </>,
      );
      const area = document.querySelector('area')!;
      fireEvent(area, new MouseEvent('click', { bubbles: true, cancelable: true }));
      // The HTMLAreaElement branch of findAnchor must intercept — removing it
      // leaves no dialog.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('a disconnected captured area[href] safe-cancels without leaking either flag', async () => {
      const user = userEvent.setup();
      function Harness() {
        const [show, setShow] = useState(true);
        return (
          <>
            <TrackedCard />
            {show && (
              <map name="hotmap">
                <area href="/settings/indexers" shape="rect" coords="0,0,20,20" alt="AreaLink" />
              </map>
            )}
            <img src="hot.png" useMap="#hotmap" alt="hotspot" width={20} height={20} />
            <Link to="/library">Library</Link>
            <button type="button" onClick={() => setShow(false)}>
              hide-area
            </button>
          </>
        );
      }
      renderGuard(<Harness />);
      fireEvent(
        document.querySelector('area')!,
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Disconnect the captured area, then Discard → safe-cancel (isConnected false).
      await user.click(screen.getByRole('button', { name: 'hide-area' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentPath()).toBe('/settings');

      // Flags cleared: a subsequent dirty link still guards, and a dirty
      // beforeunload still prompts.
      await user.click(screen.getByRole('link', { name: 'Library' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Stay on page' }));
      expect(dispatchBeforeunload()).toBe(true);
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

    it('blocks a link and disables Discard when only pending (not dirty) (F7)', async () => {
      const user = userEvent.setup();
      renderGuard(
        <>
          <TrackedCard dirty={false} pending />
          <Link to="/settings/indexers">Indexers</Link>
        </>,
      );
      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      // Pending-only must still block (removing `|| anyPending` from isBlocking
      // would leave no dialog to find).
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
      expect(currentPath()).toBe('/settings');
    });

    it('prevents beforeunload when only pending (not dirty) (F7)', () => {
      render(
        <MemoryRouter initialEntries={['/settings']}>
          <UnsavedChangesGuard />
          <TrackedCard dirty={false} pending />
        </MemoryRouter>,
      );
      expect(dispatchBeforeunload()).toBe(true);
    });

    it('re-enables Discard (draft intact, no navigation) when a pending save fails (F8)', async () => {
      const user = userEvent.setup();
      function Harness() {
        // Dirty stays true throughout; pending flips true→false as the save
        // settles (a failure leaves the form dirty).
        const [pending, setPending] = useState(true);
        return (
          <>
            <TrackedCard dirty pending={pending} />
            <Link to="/settings/indexers">Indexers</Link>
            <button type="button" onClick={() => setPending(false)}>
              fail-save
            </button>
          </>
        );
      }
      renderGuard(<Harness />);
      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();

      // Save fails: pending clears but the draft is still dirty.
      await user.click(screen.getByRole('button', { name: 'fail-save' }));

      // Modal stays open, Discard re-enables, and nothing navigated.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
      expect(currentPath()).toBe('/settings');
    });
  });

  describe('beforeunload + suppression flag', () => {
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

    it('a stale safe-cancel clears an already-armed beforeunload-suppression flag (F1)', async () => {
      const user = userEvent.setup();
      function Harness() {
        const [show, setShow] = useState(true);
        return (
          <>
            <a href="/library">Plain</a>
            {show && <Link to="/settings/indexers">Vanishing</Link>}
            <button type="button" onClick={() => setShow(false)}>
              hide
            </button>
          </>
        );
      }
      renderPersistent(<Harness />);

      // 1. Arm suppression via a plain-anchor (document-nav) Discard. Do NOT
      //    dispatch beforeunload afterwards, so the flag stays armed.
      await user.click(screen.getByRole('link', { name: 'Plain' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));

      // 2. Intercept the SPA Link, unmount it, then Discard → stale safe-cancel,
      //    which must clear the armed suppression flag.
      await user.click(screen.getByRole('link', { name: 'Vanishing' }));
      await user.click(screen.getByRole('button', { name: 'hide' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));

      // 3. Because the stale branch cleared suppression, the next dirty
      //    beforeunload still prompts. If the stale-branch reset of
      //    suppressNextBeforeunload were removed, this would be swallowed (false).
      expect(dispatchBeforeunload()).toBe(true);
    });
  });

  it('Discard replay preserves Link replace and state semantics (F9)', async () => {
    const user = userEvent.setup();
    function StateProbe() {
      const location = useLocation();
      return <div data-testid="state">{JSON.stringify(location.state)}</div>;
    }
    function BackButton() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(-1)}>
          back
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={['/start', '/settings']} initialIndex={1}>
        <UnsavedChangesGuard />
        <LocationProbe />
        <StateProbe />
        <BackButton />
        <Routes>
          <Route path="/start" element={<div>start page</div>} />
          <Route
            path="/settings"
            element={
              <>
                <TrackedCard />
                <Link to="/settings/indexers" replace state={{ from: 'guard' }}>
                  Go
                </Link>
              </>
            }
          />
          <Route path="/settings/indexers" element={<div>indexers page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: 'Go' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    // State survives the replay (a reconstructed navigate(href) would drop it).
    expect(screen.getByTestId('state').textContent).toBe(JSON.stringify({ from: 'guard' }));
    expect(currentPath()).toBe('/settings/indexers');

    // replace: the /settings entry was replaced, so going back lands on /start,
    // not /settings (a push would have kept /settings on the stack).
    await user.click(screen.getByRole('button', { name: 'back' }));
    expect(currentPath()).toBe('/start');
  });

  it('never intercepts a Save-button click or Enter form submission while dirty (F14)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    renderGuard(
      <>
        <TrackedCard />
        <form onSubmit={onSubmit}>
          <input aria-label="field" defaultValue="x" />
          <button type="submit">Save</button>
        </form>
      </>,
    );

    // Save click submits the form; the guard (anchor-only) never intercepts.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Enter in a field submits; still no interception.
    await user.type(screen.getByLabelText('field'), '{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(currentPath()).toBe('/settings');
  });

  it('renders Stay as primary and Discard as secondary on the guard modal (F15)', async () => {
    const user = userEvent.setup();
    renderGuard(
      <>
        <TrackedCard />
        <Link to="/settings/indexers">Indexers</Link>
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Indexers' }));

    const stay = screen.getByRole('button', { name: 'Stay on page' });
    const discard = screen.getByRole('button', { name: 'Discard changes' });
    // Guard wires cancelVariant="primary" / confirmVariant="secondary"; swapping
    // or dropping either prop changes these classes.
    expect(stay).toHaveClass('bg-primary', 'text-primary-foreground');
    expect(discard).not.toHaveClass('bg-destructive');
    expect(discard).toHaveClass('border', 'border-border');
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
