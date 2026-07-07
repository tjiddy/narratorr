import { describe, it, expect, beforeEach, vi } from 'vitest';

// Boot-wiring test (#1842, F1): the instance-badge feature runs automatically only because
// main.tsx invokes applyInstanceBadge() at startup. The helper/effect suites would all stay
// green if that call were deleted, so this asserts the entrypoint actually wires it up.

const { applyInstanceBadgeMock, renderMock, createRootMock } = vi.hoisted(() => ({
  applyInstanceBadgeMock: vi.fn(),
  renderMock: vi.fn(),
  createRootMock: vi.fn(() => ({ render: renderMock, unmount: vi.fn() })),
}));

// Stub the DOM mount so importing main.tsx doesn't render the full React tree.
vi.mock('react-dom/client', () => ({
  default: { createRoot: createRootMock },
}));

vi.mock('./lib/apply-instance-badge', () => ({
  applyInstanceBadge: applyInstanceBadgeMock,
}));

describe('main.tsx boot wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    applyInstanceBadgeMock.mockClear();
    createRootMock.mockClear();
    renderMock.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('invokes applyInstanceBadge() once during boot', async () => {
    await import('./main');

    expect(createRootMock).toHaveBeenCalledTimes(1); // boot actually ran
    expect(applyInstanceBadgeMock).toHaveBeenCalledTimes(1);
  });
});
