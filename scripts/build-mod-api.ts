// Writes packages/mod-api (the @deadboard/mod-api types for code-mod authors) from the API's single
// source, src/mods/api/types.ts:  npx tsx scripts/build-mod-api.ts   (npm run mod-api)
// test/modcode.test.ts fails when the package is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiPackageFiles } from '../src/mods/api/package';

const ROOT = new URL('..', import.meta.url).pathname;
const files = apiPackageFiles(readFileSync(join(ROOT, 'src/mods/api/types.ts'), 'utf8'));
for (const [name, text] of Object.entries(files)) writeFileSync(join(ROOT, 'packages/mod-api', name), text);
console.log(`packages/mod-api: ${Object.keys(files).join(', ')}`);
