import type { HostMessage, WebviewMessage } from '@flowbook/core';

/** Everything the webview needs from its container; VS Code in production, a mock in dev. */
export interface Host {
  post(msg: WebviewMessage): void;
  /** Subscribes to host messages; returns an unsubscribe function. */
  onMessage(cb: (m: HostMessage) => void): () => void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export function vscodeHost(): Host {
  const api = acquireVsCodeApi();
  return {
    post: (msg) => api.postMessage(msg),
    onMessage(cb) {
      const listener = (e: MessageEvent<HostMessage>) => {
        if (e.data && typeof e.data === 'object' && 'type' in e.data) cb(e.data);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    getState: <T>() => api.getState() as T | undefined,
    setState: (s) => {
      api.setState(s);
    },
  };
}
