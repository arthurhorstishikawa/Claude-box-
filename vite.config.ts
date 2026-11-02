import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages under any repository name.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
} as any);
