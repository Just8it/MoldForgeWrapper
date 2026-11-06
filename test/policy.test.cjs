const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isAllowed, isLocal, assetPath } = require('../main.cjs');
test('only bundled resources and in-memory data are allowed', () => {
  for (const url of ['https://nordiclayerlab.se/moldforge/app/', 'http://127.0.0.1/private', 'ws://localhost:1234', 'wss://example.com', 'file:///C:/secret', 'ftp://example.com', 'moldforge://evil/a', 'moldforge://app.evil/a', 'moldforge://user@app/a']) assert.equal(isAllowed(url), false, url);
  for (const url of ['moldforge://app/', 'moldforge://app/assets/a.js', 'blob:moldforge://app/test', 'data:text/plain,hello']) assert.equal(isAllowed(url), true, url);
  assert.equal(isLocal('blob:moldforge://app/test'), false);
});
test('asset paths cannot escape the bundle', () => {
  const root = path.resolve('site');
  assert.equal(assetPath(root, 'moldforge://app/'), path.join(root, 'index.html'));
  for (const url of ['moldforge://app/..%2fsecret', 'moldforge://app/%2e%2e%5csecret', 'moldforge://app/%00', 'moldforge://app/%ZZ', 'file:///secret']) assert.equal(assetPath(root, url), null, url);
});
test('all bundled files match their recorded hashes', () => {
  const manifest = require('../site/snapshot.json');
  assert.ok(Object.keys(manifest.files).length > 20);
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join('site', name))).digest('hex'), hash, name);
  }
  assert.ok(!fs.readFileSync('site/index.html', 'utf8').includes('registerSW.js'));
});
