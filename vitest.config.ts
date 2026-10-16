import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves project sites at /<repo>/; local dev stays at /.
  base: process.env.GITHUB_ACTIONS ? '/water-maze/' : '/',
  // Only this repo's tests: git worktrees under .claude/ carry their own copies.
  test: { include: ['test/**/*.test.ts'] },
});
