import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Wichtig für Electron (relative Pfade)
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  }
});