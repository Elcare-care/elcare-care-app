/**
 * CLI script: generates openapi.json from the Zod-based registry and writes it
 * next to the indexer package.json.
 *
 * Usage:
 *   npx tsx src/generate-openapi.ts
 *
 * The CI `check-openapi` job runs this script and diffs the output against the
 * committed openapi.json, failing if they differ.
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { buildOpenApiDocument } from './api/openapi.js';

const doc = buildOpenApiDocument();
// Always write next to package.json (one level above src/). Resolving the path
// from this module rather than from process.cwd() keeps the output stable no
// matter which directory the script is invoked from.
const outPath = fileURLToPath(new URL('../openapi.json', import.meta.url));

writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`✓ OpenAPI spec written to ${outPath}`);
