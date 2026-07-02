/**
 * Route-level error boundary. A render error in any single screen is caught here
 * and shown as a recoverable panel - the app shell (sidebar/nav) stays usable and
 * the user can retry or reload, instead of the whole SPA white-screening.
 *
 * Keyed on the current pathname by the caller so that navigating away from a
 * broken screen automatically clears the error and re-renders the new route.
 */

import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; onReset?: () => void }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Surface to the console for diagnostics; a real deployment would forward
    // this to an error-tracking sink.
    console.error('Screen render error caught by ErrorBoundary:', error);
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            margin: 'var(--space-6, 32px) auto', maxWidth: 560, textAlign: 'center',
            padding: 'var(--space-6, 32px)', borderRadius: 12,
            border: '1px solid var(--color-border, #e2e8f0)',
            background: 'var(--color-surface, #fff)',
          }}
        >
          <h2 style={{ marginBottom: 8 }}>Something went wrong on this screen</h2>
          <p style={{ color: 'var(--color-text-muted, #64748b)', marginBottom: 20 }}>
            This screen hit an unexpected error. The rest of RIOS is still usable — you can retry this
            screen or reload the app.
          </p>
          <div style={{ display: 'inline-flex', gap: 12 }}>
            <button
              onClick={this.reset}
              style={{
                padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
                border: 'none', color: '#fff', background: 'var(--color-primary, #2563eb)',
              }}
            >
              Retry
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
                border: '1px solid var(--color-border, #e2e8f0)', background: 'transparent',
                color: 'var(--color-text, #0f172a)',
              }}
            >
              Reload app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
