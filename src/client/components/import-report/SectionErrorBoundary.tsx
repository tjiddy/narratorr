import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: ReactNode;
}
interface State {
  hasError: boolean;
}

/**
 * A local error boundary that isolates a single major section (#1894, F5 /
 * REACT-5). Unlike the app-level `ErrorBoundary` (full-screen "reload the page"),
 * this renders a compact inline `fallback` in place of ONLY its children, so a
 * render-time failure in the import-history section cannot reach the route
 * boundary and take the sibling event-history list down with it.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
