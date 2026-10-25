import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { jsonSchemas } from './json-schema.js';

const out = process.argv[2];
if (!out) throw new Error('usage: emit-schema <output.json>');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(jsonSchemas(), null, 2) + '\n');
