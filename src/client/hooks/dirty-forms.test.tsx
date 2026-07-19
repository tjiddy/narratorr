import { Component, StrictMode, useState, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, renderHook, screen, act } from '@testing-library/react';
import { useTrackedForm, useDirtyFormsState, _resetForTesting } from './dirty-forms';

// Minimal error boundary so a component that throws during render can be
// rendered without failing the test — used to prove an aborted render commits
// no registry entry.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <div>caught</div> : this.props.children;
  }
}

function TrackedForm({
  isDirty = false,
  isPending = false,
  label,
}: {
  isDirty?: boolean;
  isPending?: boolean;
  label: string;
}) {
  useTrackedForm({ isDirty, isPending, label });
  return null;
}

// Reactive read of the module store — re-renders whenever the store notifies.
function readState() {
  return renderHook(() => useDirtyFormsState()).result;
}

beforeEach(() => {
  _resetForTesting();
});

describe('dirty-forms registry', () => {
  it('registers a dirty form with its label and drops it on unmount', () => {
    const form = render(<TrackedForm label="Merge & Convert" isDirty />);
    const state = readState();
    expect(state.current.dirtyLabels).toEqual(['Merge & Convert']);

    form.unmount();
    // The effect cleanup removes the entry and notifies subscribers.
    expect(state.current.dirtyLabels).toEqual([]);
  });

  it('retains a clean-again form in the Map but excludes it from dirtyLabels', () => {
    function Harness() {
      const [dirty, setDirty] = useState(true);
      return (
        <>
          <TrackedForm label="Filtering" isDirty={dirty} />
          <button type="button" onClick={() => setDirty(false)}>
            clean
          </button>
        </>
      );
    }
    render(<Harness />);
    const state = readState();
    expect(state.current.dirtyLabels).toEqual(['Filtering']);

    act(() => {
      screen.getByRole('button').click();
    });
    // Entry retained (dirty:false), so it no longer shows in the label list.
    expect(state.current.dirtyLabels).toEqual([]);
  });

  it('shows both labels for two dirty forms; cleaning one leaves the other', () => {
    function Harness() {
      const [firstDirty, setFirstDirty] = useState(true);
      return (
        <>
          <TrackedForm label="Housekeeping" isDirty={firstDirty} />
          <TrackedForm label="Logging" isDirty />
          <button type="button" onClick={() => setFirstDirty(false)}>
            clean-first
          </button>
        </>
      );
    }
    render(<Harness />);
    const state = readState();
    expect(state.current.dirtyLabels).toEqual(['Housekeeping', 'Logging']);

    act(() => {
      screen.getByRole('button').click();
    });
    expect(state.current.dirtyLabels).toEqual(['Logging']);
  });

  it('tracks anyPending independently of dirty', () => {
    render(<TrackedForm label="Import" isDirty={false} isPending />);
    const state = readState();
    expect(state.current.dirtyLabels).toEqual([]);
    expect(state.current.anyPending).toBe(true);
  });

  it('derives the registry only from committed mounts (commit-phase sync)', () => {
    // A Probe alone (no tracked form) reads empty; only once a tracked form
    // commits does its entry appear — the store is never written during render
    // (further proven by the StrictMode case, which leaves no phantom entry).
    const state = readState();
    expect(state.current.dirtyLabels).toEqual([]);

    render(<TrackedForm label="Network" isDirty />);
    expect(state.current.dirtyLabels).toEqual(['Network']);
  });

  it('yields exactly one live entry under StrictMode double-mount', () => {
    render(
      <StrictMode>
        <TrackedForm label="Quality" isDirty />
      </StrictMode>,
    );
    const state = readState();
    expect(state.current.dirtyLabels).toEqual(['Quality']);
  });

  it('an aborted (throwing) render commits no phantom entry (F2)', () => {
    function Exploder(): null {
      // The registration is scheduled as a layout effect; because this render
      // throws, React discards it and the effect never commits. A render-phase
      // write would instead leak a 'Ghost' entry that nothing cleans up.
      useTrackedForm({ isDirty: true, isPending: false, label: 'Ghost' });
      throw new Error('render aborted');
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Boundary>
        <Exploder />
      </Boundary>,
    );
    errorSpy.mockRestore();

    const state = readState();
    expect(state.current.dirtyLabels).not.toContain('Ghost');
    expect(state.current.dirtyLabels).toEqual([]);
  });

  it('does not warn about update-during-render under StrictMode across a dirty flip (F2)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness() {
      const [dirty, setDirty] = useState(true);
      return (
        <>
          <TrackedForm label="Quality" isDirty={dirty} />
          <button type="button" onClick={() => setDirty(false)}>
            clean
          </button>
        </>
      );
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    act(() => {
      screen.getByRole('button').click();
    });
    // Writes happen only in committed effects, so React never warns that the
    // store notified (updated a subscriber) during another component's render.
    const warned = errorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          /Cannot update a component .* while rendering a different component|update a component while rendering/i.test(arg),
      ),
    );
    errorSpy.mockRestore();
    expect(warned).toBe(false);
  });

  it('updates a mounted entry when its label prop changes (F3)', () => {
    const view = render(<TrackedForm label="Old Name" isDirty />);
    const state = readState();
    expect(state.current.dirtyLabels).toEqual(['Old Name']);

    // Rerender the SAME mounted form (stable useId) with a new label. The effect
    // must re-run on the label change (removing `label` from its deps would keep
    // the stale name, which the guard modal would then display).
    view.rerender(<TrackedForm label="New Name" isDirty />);
    expect(state.current.dirtyLabels).toEqual(['New Name']);
  });

  it('getSnapshot returns a stable reference between notifications', () => {
    const state = readState();
    const first = state.current;
    // No store mutation happened, so re-reading returns the same cached object.
    expect(state.current).toBe(first);
  });

  it('_resetForTesting clears entries and notifies subscribers', () => {
    render(<TrackedForm label="Search" isDirty />);
    const state = readState();
    expect(state.current.dirtyLabels).toEqual(['Search']);

    act(() => {
      _resetForTesting();
    });
    expect(state.current.dirtyLabels).toEqual([]);
  });
});
