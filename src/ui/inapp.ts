// Built-in browsers of social and chat apps (a link tapped in Threads, Instagram, Facebook, …).
// They are WebViews without WebGPU, even when their user agent names a current Chrome or Safari,
// so the bench cannot start there: the visitor has to reopen the page in a real browser.

const APPS: [RegExp, string][] = [
  [/\bBarcelona\b/, 'Threads'],
  [/Instagram/, 'Instagram'],
  [/FBAN|FBAV|FB_IAB|FBIOS/, 'Facebook'],
  [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok'],
  [/MicroMessenger/, 'WeChat'],
  [/\bLine\//, 'LINE'],
  [/Snapchat/, 'Snapchat'],
  [/LinkedInApp/, 'LinkedIn'],
  [/Telegram/, 'Telegram'],
  [/\bTwitter\b/, 'X'],
  [/\bReddit\b/, 'Reddit'],
  [/Discord/, 'Discord'],
];

/**
 * The app whose built-in browser this is: its name, '' for an unnamed Android WebView, or null in a
 * real browser.
 */
export function inAppBrowser(ua: string): string | null {
  for (const [re, name] of APPS) if (re.test(ua)) return name;
  if (/Android/.test(ua) && /;\s*wv\)/.test(ua)) return '';
  return null;
}

/** An Android link that opens `url` in Chrome (from a WebView, a plain link would stay inside it). */
export function chromeIntentUrl(url: string): string {
  const u = new URL(url);
  return `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;end`;
}
