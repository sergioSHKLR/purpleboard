// The @deadboard/mod-api type package, generated from types.ts (scripts/build-mod-api.ts writes it;
// the test compares). index.d.ts: the types as modules; global.d.ts: the same types in a global
// namespace `DeadboardMod`, for plain-JavaScript mods (they can't contain the word that loads
// other modules, so JSDoc reaches the types through `/// <reference types="@deadboard/mod-api/global" />`).
import { API_VERSION } from './version';

export function apiPackageFiles(typesSource: string): Record<string, string> {
  const names = [...typesSource.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
  const head = `// @deadboard/mod-api ${API_VERSION}: types of the DEADBOARD plug-in API (generated from\n// src/mods/api/types.ts in the DEADBOARD repository; do not edit).\n`;
  const body = typesSource.replace(/^\/\/[^\n]*\n(\/\/[^\n]*\n)*\n?/, '');
  return {
    'index.d.ts': `${head}\n${body}`,
    'global.d.ts': `${head}\ndeclare namespace DeadboardMod {\n${names.map((n) => `  type ${n} = import('./index').${n};`).join('\n')}\n}\n`,
    'package.json': `${JSON.stringify({
      name: '@deadboard/mod-api',
      version: API_VERSION,
      description: 'Types of the DEADBOARD plug-in API, for code mods (solvers and tools that run in the game\'s sandbox).',
      license: 'Apache-2.0',
      types: 'index.d.ts',
      files: ['index.d.ts', 'global.d.ts', 'README.md'],
      exports: { '.': { types: './index.d.ts' }, './global': { types: './global.d.ts' } },
      repository: { type: 'git', url: 'https://github.com/tholtman1-del/deadboard', directory: 'packages/mod-api' },
    }, null, 2)}\n`,
  };
}
