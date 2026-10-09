import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2022' },
  server: { port: 5173, strictPort: true },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node'
  }
});
