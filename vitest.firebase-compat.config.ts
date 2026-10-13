import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^firebase\/(.*)$/, replacement: 'firebase-compat/$1' },
    ],
  },
  test: {
    include: ['tests/firebase.test.ts'],
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
  },
});
