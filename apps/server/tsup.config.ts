import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Internal workspace packages are TypeScript sources: bundle them.
  noExternal: [/^@photobooth\//],
  // Native / heavy deps stay external and are resolved from node_modules at runtime.
  external: ['sharp', '@prisma/client', '.prisma/client', 'serialport', 'mqtt', 'ws', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  banner: {
    js: "import { createRequire as __pbCreateRequire } from 'module'; const require = __pbCreateRequire(import.meta.url);",
  },
});
