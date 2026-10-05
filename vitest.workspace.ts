import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/test/**/*.test.ts', 'apps/server/test/unit/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30000,
    },
  },
  {
    test: {
      name: 'integration',
      include: ['apps/server/test/integration/**/*.test.ts'],
      environment: 'node',
      globalSetup: ['apps/server/test/integration/global-setup.ts'],
      fileParallelism: false,
      // One shared PostgreSQL test database: run files strictly one after another.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 180000,
      hookTimeout: 120000,
    },
  },
]);
