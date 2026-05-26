#!/usr/bin/env node
/**
 * Pre-publish script to sync package versions.
 *
 * Sets every package's version to match the root package.json version
 * before publishing to npm.
 *
 * Usage: node scripts/sync-versions.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const PACKAGES = ["mcp"];

const rootPkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8"));
const version = rootPkg.version;

console.log(`Syncing all packages to version ${version}...\n`);

for (const pkg of PACKAGES) {
  const pkgPath = resolve(rootDir, "packages", pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const changes = [];

  if (pkgJson.version !== version) {
    changes.push(`  version: ${pkgJson.version} → ${version}`);
    pkgJson.version = version;
  }

  if (changes.length > 0) {
    writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n");
    console.log(`✓ ${pkgJson.name}`);
    for (const change of changes) console.log(change);
  } else {
    console.log(`✓ ${pkgJson.name} (no changes)`);
  }
}

console.log(`\nDone. All packages at ${version}.`);
