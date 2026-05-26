import { defineConfig } from "vitest/config";

import { createBuildConfig, createTestConfig, versionDefine } from "../../vite.config.base.ts";

export default defineConfig({
  define: versionDefine(),
  build: createBuildConfig({
    entry: {
      server: "./src/server.ts",
      proxy: "./src/proxy.ts",
    },
    external: [
      /^@modelcontextprotocol\/sdk/,
      /^h3/,
      // @shopify/dev-mcp is a peer dep — spawned as a child process, not imported
    ],
  }),
  test: {
    ...createTestConfig({ name: "mcp" }),
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/server.ts"],
    },
  },
});
