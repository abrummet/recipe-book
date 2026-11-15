import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' lets the built app work from any folder, including a GitHub Pages project site.
export default defineConfig({
  base: './',
  plugins: [react()],
});
