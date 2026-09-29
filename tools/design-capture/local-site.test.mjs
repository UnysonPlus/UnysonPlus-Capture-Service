/**
 * Guards for the local-site boundary.
 *
 * The site-fix agent runs with file and shell tools, so this predicate decides whether a remote-execution
 * vector opens. The negatives matter more than the positives here: every one of them is a string that
 * CONTAINS a local-looking token while pointing somewhere else, which is exactly what a regex written
 * against the whole URL would wave through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalSite } from './local-site.mjs';

test('the local machine is local', () => {
  for (const u of [
    'http://localhost/', 'http://localhost:8080/about', 'https://localhost/x',
    'http://127.0.0.1/', 'http://127.0.0.1:8000/a', 'http://127.1.2.3/',
    'http://[::1]/', 'http://mysite.localhost/', 'http://site.test/', 'http://shop.local/',
  ]) assert.equal(isLocalSite(u), true, u);
});

test('a LAN dev box is local', () => {
  for (const u of ['http://192.168.1.50/', 'http://10.0.0.7/wp', 'http://172.16.4.2/', 'http://172.31.255.1/'])
    assert.equal(isLocalSite(u), true, u);
});

test('NEGATIVE: a hostname that merely CONTAINS a local token is not local', () => {
  // The attack this exists for: a label-wise comparison rejects these, a substring search accepts them.
  for (const u of [
    'https://localhost.evil.com/',      // "localhost" is a label, but not the TLD
    'https://mylocalhost.com/',
    'https://test.evil.com/',           // "test" is a label, but not the TLD
    'https://127.0.0.1.evil.com/',
    'https://local.example.org/',
  ]) assert.equal(isLocalSite(u), false, u);
});

test('NEGATIVE: a local token in the path, query or fragment is not the host', () => {
  for (const u of [
    'https://evil.com/localhost',
    'https://evil.com/?host=localhost',
    'https://evil.com/#http://localhost/',
    'https://evil.com/redirect?to=http://127.0.0.1/',
  ]) assert.equal(isLocalSite(u), false, u);
});

test('NEGATIVE: userinfo does not make a host local', () => {
  // `http://localhost@evil.com/` has hostname evil.com — the part before @ is credentials, not the host.
  assert.equal(isLocalSite('http://localhost@evil.com/'), false);
  assert.equal(isLocalSite('http://127.0.0.1@evil.com/'), false);
});

test('NEGATIVE: a public IP outside the private ranges is not local', () => {
  for (const u of [
    'http://172.15.0.1/',   // just below the 172.16/12 block
    'http://172.32.0.1/',   // just above it
    'http://11.0.0.1/',     // adjacent to 10/8
    'http://193.168.1.1/',  // looks like 192.168 at a glance
    'http://8.8.8.8/',
  ]) assert.equal(isLocalSite(u), false, u);
});

test('NEGATIVE: a non-http scheme is never a site', () => {
  for (const u of ['file:///C:/wp/index.php', 'javascript:alert(1)', 'ftp://localhost/', 'data:text/html,x'])
    assert.equal(isLocalSite(u), false, u);
});

test('NEGATIVE: junk input is refused rather than thrown on', () => {
  for (const u of ['', null, undefined, 'not a url', '://', {}, 42])
    assert.equal(isLocalSite(u), false, String(u));
});

test('a real production host is not local', () => {
  assert.equal(isLocalSite('https://www.example.com/about'), false);
});
