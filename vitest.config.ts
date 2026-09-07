import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default defineConfig(async (environment) => {
  const base = typeof viteConfig === "function"
    ? await viteConfig(environment)
    : await viteConfig;
  return mergeConfig(base, {
    test: {
      // Browser/CLI smoke artifacts can contain third-party package tests.
      exclude: [...configDefaults.exclude, "output/**"],
    },
  });
});
