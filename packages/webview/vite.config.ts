import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The extension loads dist/webview.js and dist/webview.css by these fixed names.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['../..'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    // One self-contained script: the webview CSP only allows the files the extension lists.
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: (info) =>
          info.names?.[0]?.endsWith('.css') ? 'webview.css' : '[name][extname]',
        codeSplitting: false,
      },
    },
  },
});
