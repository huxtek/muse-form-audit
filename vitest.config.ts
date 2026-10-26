import path from 'path';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vitest/config';

/**
 * One root config, two Vitest projects, so a single `npm test` covers both
 * halves of the repo with the environment each half actually needs:
 *
 * - `client` runs the React/TypeScript tests under `tests/client` in jsdom,
 *   with the same `@` alias and JSX transform the app build uses.
 * - `server` runs the Express-side tests under `tests/server` in node, where
 *   `dns`, `net` and `Buffer` behave as they do in production.
 *
 * `server/` has its own package.json, but its modules are plain ESM with no
 * build step, so they import cleanly from the root install. A second Vitest
 * installation inside `server/` would double the dependency surface and split
 * the test command in two for no benefit.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@': path.resolve(import.meta.dirname, './src')
          }
        },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/setup-client.ts'],
          restoreMocks: true
        }
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.js'],
          restoreMocks: true
        }
      }
    ]
  }
});
