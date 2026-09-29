/**
 * IS THIS URL A LOCAL DEVELOPMENT SITE?
 *
 * This is a security boundary, not a convenience check. The site-fix agent runs with FILE AND SHELL
 * tools, so an endpoint that accepts any URL a form supplies is a remote-execution vector pointed at
 * whatever the caller names. The answer here decides whether that runs at all.
 *
 * It lives in its own module so it can be tested directly. A boundary that is only exercised through a
 * 15-minute agent run is a boundary nobody tests, and the interesting cases are all the ones a regex
 * written in a hurry gets wrong: `localhost.evil.com` ends with a dot-separated label that is not
 * `localhost`; `evil.com/?host=localhost` mentions it in a query; `http://user@localhost@evil.com`
 * exploits the userinfo field. Each is rejected below by parsing the URL and comparing the HOSTNAME —
 * never by searching the string.
 */

/** Hostnames that ARE the local machine. */
const EXACT = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Dev TLDs reserved for local use (RFC 6761 / 2606 and the conventional ones). */
const DEV_TLD = ['localhost', 'local', 'test', 'localdomain', 'invalid', 'example'];

/**
 * @param {string} url
 * @returns {boolean} true only when the URL's HOST is a local development target
 */
export function isLocalSite(url) {
  let h;
  try {
    const u = new URL(String(url || ''));
    // Only http(s). A `file:` or `javascript:` URL is not a site, and should never reach a runner.
    if (!/^https?:$/.test(u.protocol)) return false;
    h = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!h) return false;
  // `new URL()` gives IPv6 hosts wrapped in brackets; normalise so ::1 matches either way.
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (EXACT.has(h) || EXACT.has(bare)) return true;

  // A dev TLD, compared LABEL-WISE. `localhost.evil.com` must not pass because it contains "localhost".
  const labels = h.split('.');
  if (labels.length >= 2 && DEV_TLD.includes(labels[labels.length - 1])) return true;

  // 127.0.0.0/8 — the whole loopback range, not just .1
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;

  // RFC1918 private ranges: a LAN dev box is still a dev box.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;

  return false;
}
