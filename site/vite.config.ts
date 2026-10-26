import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  // Set TOUCHSTONE_BASE=/touchstone/ when deploying to GitHub Pages under the repo path.
  base: process.env.TOUCHSTONE_BASE ?? '/',
  plugins: [tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
});
