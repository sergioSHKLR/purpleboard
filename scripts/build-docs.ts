// Writes the generated blocks of the mod docs from the code (src/mods/docgen.ts):
//   npx tsx scripts/build-docs.ts   (npm run docs)
// test/docs.test.ts fails when a block is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiTypesMarkdown, fillGenerated, officialItemsMarkdown } from '../src/mods/docgen';
import { builtinScenarios } from '../src/scenarios/builtin';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const demos = JSON.parse(read('public/demos/index.json')) as { id: string; title: string }[];
const ref = fillGenerated(read('docs/MOD_REFERENCE.md'), 'official-items', officialItemsMarkdown(await builtinScenarios(), demos));
writeFileSync(join(ROOT, 'docs/MOD_REFERENCE.md'), ref);
const code = fillGenerated(read('docs/CODE_MODS.md'), 'api-types', apiTypesMarkdown(read('src/mods/api/types.ts')));
writeFileSync(join(ROOT, 'docs/CODE_MODS.md'), code);
console.log('docs: MOD_REFERENCE.md (official items), CODE_MODS.md (API types)');
