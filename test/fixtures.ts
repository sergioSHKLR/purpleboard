// Private regression fixtures: Apple boardview / schematic data in board_schemas/ and the
// scenario built from it in test/private/. Both are git-ignored and never ship; tests that
// need them run only when they are present on this machine.
import type { BrdQuirks } from '../src/io/brd';
import type { Scenario } from '../src/types';

export interface MacbookFixture {
  loadMacbookAirScenario(): Promise<Scenario>;
  MACBOOK_820_00165_QUIRKS: BrdQuirks;
}

export async function macbookFixture(): Promise<MacbookFixture | null> {
  const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { existsSync(p: URL): boolean };
  if (!fs.existsSync(new URL('../board_schemas/J113  820-00165.brd', import.meta.url))
    || !fs.existsSync(new URL('./private/macbook.ts', import.meta.url))) return null;
  const mod = './private/macbook.ts';
  return (await import(/* @vite-ignore */ mod)) as MacbookFixture;
}
