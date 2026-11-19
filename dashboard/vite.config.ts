import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/dashboard/static/assets/',
  envDir: false,
  envPrefix: [],
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../src/dashboard/static/assets',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: fileURLToPath(new URL('./main.tsx', import.meta.url)),
      output: { entryFileNames: 'app.js', assetFileNames: '[name][extname]' },
    },
  },
});
