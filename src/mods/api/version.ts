/** The plug-in API version this app implements (mods ask for a range in mod.json: "api": "^1"). */
export const API_VERSION = '1.0.0';

/** Permissions a code mod can ask for (docs/MODDING.md → Code mods). */
export const PERMISSIONS = {
  /** http://127.0.0.1 and http://localhost, e.g. a local model server. */
  localhost: 'network:localhost',
  /** Panels in the Mods tab, and ui.zoomTo / ui.say. */
  panel: 'panel',
  /** api.storage: a small store for the mod. */
  storage: 'storage',
} as const;
/** `network:https://host[:port]`: one named HTTPS origin. */
export const NETWORK_ORIGIN = /^network:https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
/** Planned, not available yet: accepted with a note, not granted. */
export const LATER_PERMISSIONS: string[] = [];

/** The one export a code mod has: `export default function activate(api) { … }`. */
export const EXPORT_DEFAULT = /\bexport\s+default\b/;

/**
 * Why a code mod's source can't run, or null. Deliberately plain text checks, not a parser a
 * crafted file could confuse: comments and strings count too.
 *
 * - The mod runs as a classic script (importScripts, which the sandbox's Content-Security-Policy
 *   governs), so it can't load other code through module syntax. Its single
 *   `export default` is rewritten to an assignment first; any other export is refused (it would be
 *   a way back to module loading, e.g. `export * from "https://…"`).
 * - Chrome lets a worker's dynamic import() fetch any URL despite the CSP, and `import` is syntax
 *   (eval is blocked), so the word must appear in the source to be used: it is refused.
 */
export function codeProblem(source: string): string | null {
  if (/\bimport\b/.test(source)) return 'code mods can\'t use import or import(): bundle the mod into one file (the word "import" may not appear, not even in a comment or a string)';
  const exports = source.match(/\bexport\b/g)?.length ?? 0;
  const defaults = source.match(new RegExp(EXPORT_DEFAULT.source, 'g'))?.length ?? 0;
  if (exports !== defaults || defaults > 1) return 'a code mod is one script whose only export is "export default function activate(api) { … }" (no other export, no "export … from"; the word "export" may not appear anywhere else, not even in a comment or a string)';
  if (source.length > 2_000_000) return 'the code file is larger than 2 MB';
  return null;
}
