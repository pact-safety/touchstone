import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  // Set TOUCHSTONE_BASE (e.g. /touchstone/) only when serving under a subpath; the live site is at a domain root.
  base: process.env.TOUCHSTONE_BASE ?? '/',
  plugins: [tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
});
