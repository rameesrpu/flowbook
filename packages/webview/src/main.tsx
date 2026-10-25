import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { vscodeHost } from './host';

const host = vscodeHost();
const report = (message: string) => host.post({ type: 'error', message });
window.addEventListener('error', (e) => report(e.error?.stack ?? e.message));
window.addEventListener('unhandledrejection', (e) =>
  report(e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)),
);

createRoot(
  document.getElementById('root') ?? document.body.appendChild(document.createElement('div')),
).render(
  <ErrorBoundary resetKey="app" onError={(e) => report(e.stack ?? e.message)}>
    <App host={host} />
  </ErrorBoundary>,
);
