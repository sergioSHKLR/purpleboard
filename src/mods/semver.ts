// Mod versions and version ranges (the subset of semver that mod.json needs).
//
// Versions: MAJOR.MINOR.PATCH, optionally with a "-prerelease" tag ("1.2.0-beta.1"), which sorts
// before the release. Build metadata ("+abc") is ignored.
// Ranges: "*", "1.2.3" (exact), "^1.2" (same major; for 0.x the same minor), "~1.2.3" (same minor),
// ">=1.0", ">1.0", "<=2", "<2", and several of these separated by spaces (all must hold).
// Missing parts count as 0: "^1" = "^1.0.0".

export interface Version { major: number; minor: number; patch: number; pre: string }

const STRICT = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const LOOSE = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Strict MAJOR.MINOR.PATCH (what deadboard-mod/2 requires), or null. */
export function parseVersion(s: string): Version | null {
  const m = STRICT.exec(s.trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' } : null;
}

/** Lenient reading for deadboard-mod/1 versions ("2", "1.0", "v1.2.3"); null when not numeric. */
export function coerceVersion(s: string): Version | null {
  const m = LOOSE.exec(s.trim());
  return m ? { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] ?? '' } : null;
}

export const formatVersion = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ''}`;

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1; // a release sorts after its prereleases
  if (!b) return -1;
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const d = +pa[i] - +pb[i]; if (d) return Math.sign(d); continue; }
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch) || comparePre(a.pre, b.pre);
}

type Op = '>=' | '>' | '<=' | '<' | '=';
interface Comparator { op: Op; v: Version }

/** Parses a range into comparators that must all hold; null when it isn't a valid range. */
function parseRange(range: string): Comparator[] | null {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const out: Comparator[] = [];
  for (const p of parts) {
    if (p === '*' || p === 'x') continue;
    const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(p)!;
    const op = m[1] ?? '=';
    const nums = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?$/.exec(m[2]);
    if (!nums) return null;
    const v: Version = { major: +nums[1], minor: +(nums[2] ?? 0), patch: +(nums[3] ?? 0), pre: nums[4] ?? '' };
    const given = nums[3] !== undefined ? 3 : nums[2] !== undefined ? 2 : 1;
    const upper = (major: number, minor: number, patch: number): Comparator => ({ op: '<', v: { major, minor, patch, pre: '0' } });
    if (op === '^') {
      out.push({ op: '>=', v });
      if (v.major > 0 || given === 1) out.push(upper(v.major + 1, 0, 0));
      else if (v.minor > 0 || given === 2) out.push(upper(0, v.minor + 1, 0));
      else out.push(upper(0, 0, v.patch + 1));
    } else if (op === '~') {
      out.push({ op: '>=', v });
      out.push(given === 1 ? upper(v.major + 1, 0, 0) : upper(v.major, v.minor + 1, 0));
    } else if (op === '=' && given < 3) {
      // "1" or "1.2" as an exact range means any version in that major / minor
      out.push({ op: '>=', v });
      out.push(given === 1 ? upper(v.major + 1, 0, 0) : upper(v.major, v.minor + 1, 0));
    } else {
      out.push({ op: op as Op, v });
    }
  }
  return out;
}

export const validRange = (range: string): boolean => parseRange(range) !== null;

/** True when `version` is inside `range`. Prereleases only match a range that names a prerelease. */
export function satisfies(version: Version, range: string): boolean {
  const cs = parseRange(range);
  if (!cs) return false;
  if (version.pre && !cs.some((c) => c.v.pre && c.v.pre !== '0')) return false;
  return cs.every(({ op, v }) => {
    const d = compareVersions(version, v);
    return op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : op === '<' ? d < 0 : d === 0;
  });
}
