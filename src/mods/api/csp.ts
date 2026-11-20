// The sandbox page and its Content-Security-Policy (used by sandbox.ts; pure, so tests can read it).
import { NETWORK_ORIGIN, PERMISSIONS } from './version';

/** connect-src for a mod's permissions ('none' unless it asked for network access). */
export function connectSrc(permissions: string[]): string {
  const out: string[] = [];
  for (const p of permissions) {
    if (p === PERMISSIONS.localhost) out.push('http://127.0.0.1:*', 'http://localhost:*');
    else if (NETWORK_ORIGIN.test(p)) out.push(p.slice('network:'.length));
  }
  return out.length ? out.join(' ') : "'none'";
}

export function sandboxHtml(permissions: string[]): string {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'",
    'worker-src blob:',
    `connect-src ${connectSrc(permissions)}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>
addEventListener('message', function boot(e) {
  if (e.source !== parent || !e.data || e.data.t !== 'boot' || !e.ports[0]) return;
  removeEventListener('message', boot);
  var url = URL.createObjectURL(new Blob([e.data.runtime], { type: 'text/javascript' }));
  new Worker(url).postMessage({ t: 'port' }, [e.ports[0]]);
});
</script></body></html>`;
}
