import type { UserConfig } from "vite";
import type { UserConfig as VitestUserConfig } from "vitest/config";

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

/**
 * Shared Vite build config for all packages.
 */
export function createBuildConfig(options: {
  entry: Record<string, string>;
  external?: (string | RegExp)[];
  preserveModules?: boolean;
}): UserConfig["build"] {
  const { entry, external = [], preserveModules = false } = options;

  return {
    lib: {
      entry,
      formats: ["es"],
      fileName: (_format: string, entryName: string) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...external],
      output: {
        preserveModules,
      },
    },
    target: "node22",
    minify: false,
    sourcemap: true,
  };
}

export function versionDefine(): Record<string, string> {
  const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
  return { __VERSION__: JSON.stringify(pkg.version) };
}

export function createTestConfig(options?: {
  name?: string;
  setupFiles?: string[];
}): VitestUserConfig["test"] {
  const { name, setupFiles } = options ?? {};
  return {
    name,
    environment: "node",
    setupFiles,
    reporters: ["default"],
  };
}
