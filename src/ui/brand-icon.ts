// PurpleBoard app icon: a white soldering-iron tip touching a pad, with a couple of PCB traces,
// on a blue-violet (#8c72ff → #4f35c4) rounded tile. One source for the header mark (markSvg),
// public/favicon.svg and docs/brand/ (regenerate with `node scripts/brand/icon.ts`).

/** Icon artwork on a 512 grid. `id` keeps gradient/clip ids unique when inlined in a page. */
export function iconSvg({ id = 'pb', maskable = false, size }: { id?: string; maskable?: boolean; size?: number } = {}): string {
  const sz = size ? ` width="${size}" height="${size}"` : '';
  const tile = maskable ? '<rect width="512" height="512"' : '<rect width="512" height="512" rx="112"';
  // maskable: artwork shrinks into the 80 % safe circle; the tile fills the whole square
  const art = maskable ? 'translate(256 256) scale(0.74) translate(-256 -256)' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"${sz} fill="none" aria-hidden="true">`
    + `<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="#8c72ff"/><stop offset="1" stop-color="#4f35c4"/></linearGradient>`
    + `<clipPath id="${id}-c">${tile}/></clipPath></defs>`
    + `${tile} fill="url(#${id}-g)"/>`
    + `<g clip-path="url(#${id}-c)"><g transform="${art}">`
    // traces (copper, read as soft white lines) + one via
    + `<g stroke="#fff" stroke-opacity=".55" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M-160 400H112L170 342"/><path d="M226 392V430L264 468V700"/><path d="M-160 196H84L128 240"/></g>`
    + `<circle cx="142" cy="254" r="20" stroke="#fff" stroke-opacity=".55" stroke-width="16"/>`
    // the pad (annular ring with a hole) the iron is touching
    + `<circle cx="226" cy="338" r="60" fill="#fff"/><circle cx="226" cy="338" r="20" fill="#5d43d6"/>`
    // the iron: conical tip on the pad, shaft and grip running off to the top right
    + `<g transform="translate(262 302) rotate(45)" fill="#fff">`
    + `<path d="M-6 -6Q0 4 6 -6L32 -86H-32Z"/><rect x="-32" y="-206" width="64" height="124"/>`
    + `<rect x="-36" y="-222" width="72" height="12" rx="4" fill-opacity=".6"/>`
    + `<rect x="-54" y="-440" width="108" height="214" rx="26"/></g>`
    + `</g></g></svg>`;
}
