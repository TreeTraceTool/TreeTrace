#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`treetrace: ${err && err.message ? err.message : err}`);
  if (process.env.TREETRACE_DEBUG) console.error(err.stack);
  process.exit(err && Number.isInteger(err.exitCode) ? err.exitCode : 1);
});
