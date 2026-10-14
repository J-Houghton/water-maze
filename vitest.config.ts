import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Only this repo's tests: git worktrees under .claude/ carry their own copies.
  test: { include: ['test/**/*.test.ts'] },
});
