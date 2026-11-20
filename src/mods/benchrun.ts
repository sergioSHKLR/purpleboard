// Running the bench check outside the app (command line, tests): the boards players would have
// with a set of mods running (shipped boards, demos, mods' boards, patches applied, devices in use),
// and a plain-text report. File access is passed in, so this stays free of Node APIs.
import type { Scenario } from '../types';
import type { LoadedMod } from './mods';
import { resolveMods } from './resolve';
import { officialBoardAddress, officialVersions } from './official';
import { applyBoardPatches, type PatchEntry } from './patches';
import { benchCheck, type BenchContext, type BenchReport } from './benchcheck';
import type { CodeModHost } from './api/host';
import { buildNetlist, simFromResult } from './api/netlist';
import { buildDeviceOverlay } from './devices';
import { buildFaultRegistry } from './faulttypes';
import { FAULT_CLASSES } from './puzzles';
import { setFaultRangeOverlay } from '../faults';
import { setDeviceOverlay } from '../spice/devicelib';
import { builtinScenarios } from '../scenarios/builtin';
import { importScenarioOrPcb } from '../io/kicad';
import { referenceBoard, setReference } from '../scenarios/reference';

export interface BoardSource { address: string; title: string; load(): Promise<Scenario> }

/** The boards that ship with the app; demos are read with `readDemo(file)` when given. */
export async function shippedBoards(readDemo?: (file: string) => Promise<string>): Promise<BoardSource[]> {
  const out: BoardSource[] = (await builtinScenarios()).map((sc) => ({ address: officialBoardAddress(sc.id), title: sc.meta.title, load: async () => sc }));
  if (readDemo) {
    const index = JSON.parse(await readDemo('index.json')) as { id: string; file: string; title: string }[];
    for (const d of index) out.push({ address: officialBoardAddress(d.id), title: d.title, load: async () => importScenarioOrPcb(d.file, await readDemo(d.file)) });
  }
  return out;
}

/** Boards as players see them with `active` running (sets the device overlay to theirs). */
/** `host`: running code mods whose solvers the check may call. */
export function contextFor(active: LoadedMod[], shipped: BoardSource[], log?: (s: string) => void, host?: CodeModHost): BenchContext {
  setDeviceOverlay(buildDeviceOverlay(active).overlay);
  setFaultRangeOverlay(buildFaultRegistry(active, FAULT_CLASSES).ranges);
  const loaders = new Map<string, { title: string; load: () => Promise<Scenario> }>();
  for (const b of shipped) loaders.set(b.address, b);
  for (const m of active) for (const b of m.boards) if (!b.basedOn) loaders.set(b.address, { title: b.stub.meta.title, load: () => b.load() });
  const patches = new Map<string, PatchEntry[]>();
  for (const m of active) {
    for (const patch of m.manifest.patches) {
      if (patch.target.includes('/boards/')) patches.set(patch.target, [...(patches.get(patch.target) ?? []), { modId: m.manifest.id, modName: m.manifest.name, patch }]);
    }
  }
  const cache = new Map<string, Promise<{ title: string; scenario: Scenario } | null>>();
  return {
    board(address) {
      let p = cache.get(address);
      if (!p) {
        const l = loaders.get(address);
        p = l ? l.load().then((sc) => {
          const scenario = structuredClone(sc); // patches don't touch the shared original
          const ref = referenceBoard(sc);
          if (ref && ref !== sc.board) setReference(scenario, ref); // the known-good board stays with it
          const es = patches.get(address);
          if (es) applyBoardPatches(scenario, es);
          return { title: l.title, scenario };
        }) : Promise.resolve(null);
        cache.set(address, p);
      }
      return p;
    },
    boardAddresses: () => [...loaders.keys()],
    step: async (what) => { log?.(`  … ${what}`); },
    ...(host && {
      modSolvers: (modId: string) => host.solvers().filter((x) => x.modId === modId),
      solveWith: async (address, board, conn, title, o) => simFromResult(board, conn, await host.solve(address, { netlist: buildNetlist(board, conn, title, o.switches), meters: o.meters })),
    }),
  };
}

/** Checks the first mod with the others loaded beside it (its dependencies). */
export async function checkMods(mods: LoadedMod[], shipped: BoardSource[], log?: (s: string) => void, host?: CodeModHost): Promise<BenchReport> {
  const target = mods[0];
  const { active, status } = resolveMods(mods, () => true, officialVersions());
  const st = status.get(target.manifest.id);
  if (st?.state === 'blocked') {
    const why = [...st.needs.map((n) => `needs ${n.id} ${n.range}${n.have ? ` (have ${n.have})` : ''}`), ...st.conflicts.map((c) => `conflicts with ${c}`)];
    throw new Error(`${target.manifest.id} can't run: ${why.join('; ')}. Pass the mods it needs after it.`);
  }
  return benchCheck(target, active, contextFor(active, shipped, log, host));
}

export function formatReport(r: BenchReport): string {
  const mark = { pass: '✓', warn: '!', fail: '✗' } as const;
  const lines = [`Bench check: ${r.modId} (${(r.ms / 1000).toFixed(1)} s)`];
  for (const f of r.findings) lines.push(`  ${mark[f.level]} ${f.item}: ${f.text}`);
  for (const m of r.moved) {
    if (!m.nets.length) continue;
    lines.push(`  ${m.title}: ${m.netsMoved} net(s) moved${m.testsBefore !== m.testsAfter ? `, tests ${m.testsBefore ? 'passed' : 'failed'} → ${m.testsAfter ? 'pass' : 'fail'}` : ''}`);
    for (const n of m.nets) lines.push(`      ${n.net}: ${n.before.toFixed(3)} V → ${n.after.toFixed(3)} V`);
  }
  const n = (l: string) => r.findings.filter((f) => f.level === l).length;
  lines.push(`  ${n('pass')} passed · ${n('warn')} warning(s) · ${n('fail')} failed`);
  return lines.join('\n');
}
