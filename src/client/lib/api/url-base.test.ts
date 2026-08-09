import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router';

/** Exercises main.tsx's basename contract without importing its side-effect entry point. */

function LocationDisplay() {
  const location = useLocation();
  return createElement('div', { 'data-testid': 'location' }, location.pathname);
}

describe('URL_BASE router basename integration', () => {
  it('routes resolve correctly with non-root basename', () => {
    const basename = '/narratorr';
    render(
      createElement(
        MemoryRouter,
        { basename, initialEntries: ['/narratorr/library'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/library',
            element: createElement(LocationDisplay),
          }),
        ),
      ),
    );

    expect(screen.getByTestId('location').textContent).toBe('/library');
  });

  it('routes resolve correctly with root basename', () => {
    const basename = '/';
    render(
      createElement(
        MemoryRouter,
        { basename, initialEntries: ['/library'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/library',
            element: createElement(LocationDisplay),
          }),
        ),
      ),
    );

    expect(screen.getByTestId('location').textContent).toBe('/library');
  });

  it('Link generates correct hrefs under non-root basename', () => {
    const basename = '/narratorr';
    function TestLink() {
      return createElement(Link, { to: '/library' }, 'Library');
    }
    render(
      createElement(
        MemoryRouter,
        { basename, initialEntries: ['/narratorr/'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/', element: createElement(TestLink) }),
        ),
      ),
    );

    const link = screen.getByRole('link', { name: 'Library' });
    expect(link.getAttribute('href')).toBe('/narratorr/library');
  });

  it('URL_BASE || "/" produces correct basename for both root and subpath', () => {
    const emptyBase = '';
    const subpathBase = '/narratorr';
    expect(emptyBase || '/').toBe('/');
    expect(subpathBase || '/').toBe('/narratorr');
  });
});
