import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default defineConfig(async (environment) => {
  const base = typeof viteConfig === "function"
    ? await viteConfig(environment)
    : await viteConfig;
  return mergeConfig(base, {
    test: {
      // Archived worktrees and smoke artifacts are not part of this checkout.
      exclude: [...configDefaults.exclude, "output/**", ".worktrees/**"],
    },
  });
});
