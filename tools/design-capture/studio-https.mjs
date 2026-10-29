// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// A secure local address for the kit (https://127.0.0.1:8789), beside the usual http://127.0.0.1:8787. Safari does
// not let a secure page (the Studio, https://kinetic-scenes.unysonplus.com) talk to a plain http address, even on this
// computer; Chrome, Edge and Firefox allow it, so they keep using the plain one.
// The certificate is made here, once, for 127.0.0.1 and localhost only (selfsigned, MIT), and kept with the kit's
// local data. Nothing is added to the system's trusted certificates: Safari asks once (open the address, "Visit this
// website") and remembers.

import { createServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8789;

function certDir() {
  const assembled = resolve(HERE, '../../..');
  return basename(assembled) === 'assembled' ? join(assembled, 'https') : join(homedir(), '.unysonplus', 'https');
}

/** This computer's certificate for the kit (made the first time, then kept): { key, cert }. */
export async function localCert() {
  const dir = certDir(), keyFile = join(dir, 'kit-key.pem'), certFile = join(dir, 'kit-cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
  const selfsigned = (await import('selfsigned')).default;
  const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }, { name: 'organizationName', value: 'Unyson+ AI Dev Kit (this computer only)' }], {
    keySize: 2048, days: 730, algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile, pems.private, { mode: 0o600 });
  writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

/** Starts the secure listener with the same request handler as the plain one. Never stops the kit if it fails. */
export async function startHttps(handler) {
  if (/^(0|false|no|off)$/i.test(process.env.KIT_HTTPS || '')) return null;
  try {
    const { key, cert } = await localCert();
    const server = createServer({ key, cert }, handler);
    server.on('error', (e) => console.warn(`  (secure address https://127.0.0.1:${HTTPS_PORT} unavailable: ${e.code || e.message}; Safari can't use the kit)`));
    server.listen(HTTPS_PORT, '127.0.0.1', () => console.log(`  Secure address for Safari → https://127.0.0.1:${HTTPS_PORT}`));
    return server;
  } catch (e) {
    console.warn(`  (no secure address: ${e.message}; Safari can't use the kit)`);
    return null;
  }
}
