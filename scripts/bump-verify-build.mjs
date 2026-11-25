#!/usr/bin/env node
// Panelize Verify: bump the build number shown in the Verify bar
// ("Build N", from manifest.json version_name "<version>-verify.N").
// Run before every commit that changes the extension: npm run bump:build
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), 'manifest.json');
const text = readFileSync(path, 'utf8');
const manifest = JSON.parse(text);
const match = /-verify\.(\d+)$/.exec(manifest.version_name || '');
const next = match ? Number(match[1]) + 1 : 1;
const name = `${manifest.version}-verify.${next}`;
const updated = text.replace(/"version_name":\s*"[^"]*"/, `"version_name": "${name}"`);
if (updated === text) {
  throw new Error('manifest.json has no version_name to bump');
}
writeFileSync(path, updated);
console.log(`version_name -> ${name}`);
