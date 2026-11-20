# @deadboard/mod-api

Types of the DEADBOARD plug-in API, for **code mods**: solvers and tools that run inside the game's
sandbox. How code mods work, what they can and can't do, and an example: the modding guide,
section "Code mods" (docs/MODDING.md in the repository, or deadboard.org/modding.html).

TypeScript:

```ts
import type { ModApi, SolveInput, SolveResult } from '@deadboard/mod-api';
export default function activate(api: ModApi) { … }
```

Bundle the mod into one JavaScript file before you ship it. The game runs it as a plain script:
its only export is `export default function activate(api)`, and the words `import` and `export`
may not appear anywhere else in the file, even in a comment.

Plain JavaScript with JSDoc (as in `examples/mods/ideal-dc`):

```js
/// <reference types="@deadboard/mod-api/global" />
/** @param {DeadboardMod.ModApi} api */
export default function activate(api) { … }
```

A code mod runs in a Web Worker: in `tsconfig.json` use `"lib": ["es2022", "webworker"]`.

Generated from `src/mods/api/types.ts`; the package version is the plug-in API version.
