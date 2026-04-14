import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div data-testid="route-error-fallback" className="flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            </div>
            <div>
              <h2 className="font-display text-xl font-semibold mb-1">Failed to load this page</h2>
              <p className="text-muted-foreground text-sm">
                Something went wrong — try again or navigate to another page.
              </p>
            </div>
            {this.state.error?.message && (
              <pre className="text-xs text-left bg-muted rounded-xl p-3 overflow-auto max-h-24 text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 transition-all text-sm"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
