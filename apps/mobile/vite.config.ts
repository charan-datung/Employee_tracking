import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Target the oldest Android System WebView we support (Android 10 devices
// whose WebView may be several versions behind — see /CLAUDE.md rule 9).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2020',
  },
});
