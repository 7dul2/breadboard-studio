#!/usr/bin/env node
// Runs the TypeScript CLI directly through tsx (no build step needed).
import { register } from 'tsx/esm/api';
register();
const { runCli } = await import('../src/main.ts');
process.exitCode = await runCli(process.argv.slice(2));
