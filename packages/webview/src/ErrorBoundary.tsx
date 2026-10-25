import { Component, type ReactNode } from 'react';

/** Keeps a rendering bug in one view from blanking the whole webview. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey: unknown },
  { error?: Error; key?: unknown }
> {
  state: { error?: Error; key?: unknown } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey: unknown },
    state: { error?: Error; key?: unknown },
  ) {
    return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null;
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fb-error">
          <strong>Something went wrong while drawing this view.</strong>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
