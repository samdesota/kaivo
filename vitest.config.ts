import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'server/**/*.test.ts',
      'tests/unit/**/*.test.{ts,tsx}',
      'packages/**/src/**/*.test.ts',
    ],
  },
})
