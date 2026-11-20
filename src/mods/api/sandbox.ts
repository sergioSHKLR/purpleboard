// The code-mod sandbox in the browser: one hidden iframe per mod, `sandbox="allow-scripts"` (a
// unique opaque origin: no access to the app's page, cookies, storage or IndexedDB) with its own
// Content-Security-Policy (no network unless a permission opens it; no eval; no images, styles,
// forms). Inside it a worker runs the runtime and the mod's code, so a slow mod doesn't freeze the
// page. The app talks to the worker over a MessageChannel. Removing the iframe stops everything.
import runtimeJs from 'virtual:deadboard-mod-runtime';
import type { LoadedMod } from '../mods';
import type { Transport, TransportFactory } from './host';
import { sandboxHtml } from './csp';

export const sandboxTransport: TransportFactory = (mod: LoadedMod) => new Promise<Transport>((resolve, reject) => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = `mod sandbox: ${mod.manifest.id}`;
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  frame.srcdoc = sandboxHtml(mod.manifest.code?.permissions ?? []);
  // Chrome asks before a page reaches the local network; a frame must be allowed to ask
  if (mod.manifest.code?.permissions.includes('network:localhost')) frame.setAttribute('allow', 'local-network-access');
  const channel = new MessageChannel();
  frame.addEventListener('load', () => {
    if (!frame.contentWindow) { reject(new Error('sandbox did not open')); return; }
    frame.contentWindow.postMessage({ t: 'boot', runtime: runtimeJs }, '*', [channel.port2]);
    resolve({
      send: (m) => channel.port1.postMessage(m),
      onMessage: (fn) => { channel.port1.onmessage = (e) => fn(e.data); },
      close: () => { channel.port1.close(); frame.remove(); },
    });
  }, { once: true });
  document.body.appendChild(frame);
});
