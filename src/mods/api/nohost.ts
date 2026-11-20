// The code-mod host's stand-in until code mods are switched on: the real host (host.ts), the
// sandbox and its runtime load on demand, so players who never run code mods don't download them.
import type { CodeModHost } from './host';

export type CodeHostLike = Pick<CodeModHost, 'start' | 'stop' | 'stopAll' | 'status' | 'solvers' | 'importers' | 'panels' | 'solve' | 'importFile' | 'emit' | 'emitTo'>;

const off = () => Promise.reject(new Error('code mods are off'));
export const NO_CODE_HOST: CodeHostLike = {
  start: off, stop: () => {}, stopAll: () => {}, status: () => null,
  solvers: () => [], importers: () => [], panels: () => [],
  solve: off, importFile: off, emit: () => {}, emitTo: () => {},
};
