// Item addresses: `<mod-id>/<type>/<item-id>`, e.g. "official-boards/boards/builtin-first-light".
// Every item a mod provides (board, puzzle, knowledge pack, …) has one (docs/MOD_PLATFORM.md).

export const itemAddress = (modId: string, type: string, itemId: string) => `${modId}/${type}/${itemId}`;

export function parseAddress(a: string): { mod: string; type: string; item: string } | null {
  const m = /^([a-z0-9][a-z0-9._-]{1,63})\/([a-zA-Z]+)\/([a-z0-9][a-z0-9._-]{0,79})$/.exec(a);
  return m ? { mod: m[1], type: m[2], item: m[3] } : null;
}
