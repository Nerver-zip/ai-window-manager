import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // Process bootstrap owns signals/listening side effects; container startup smoke tests it.
        'src/index.ts',
        // These files contain only compile-time contracts and no executable behavior.
        'src/domain/types.ts',
        'src/domain/provider-cleanup.ts',
        'src/providers/provider.ts',
        'src/provider-clients/web-controls.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
