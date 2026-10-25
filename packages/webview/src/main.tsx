import { createRoot } from 'react-dom/client';
import { App } from './App';
import { vscodeHost } from './host';

createRoot(
  document.getElementById('root') ?? document.body.appendChild(document.createElement('div')),
).render(<App host={vscodeHost()} />);
