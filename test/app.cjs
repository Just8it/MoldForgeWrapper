const { app } = require('electron');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', path.resolve(__dirname, '../.test-profile'));
app.on('browser-window-created', (_event, win) => win.on('show', () => win.hide()));
(async () => {
  const win = await require('../main.cjs').ready;
  const ses = win.webContents.session;
  const failures = [];
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moldforge-test-'));
  win.webContents.on('console-message', details => {
    if (details.level === 'error') console.error('Renderer:', details.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => failures.push(details.reason));
  const run = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const waitFor = async (fn, timeout = 90000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await run(fn)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Timed out: ' + fn.toString() + '\n' + await run(() => document.body.innerText));
  };
  try {
    await waitFor(() => !!document.querySelector('.samples button'));
    await run(() => {
      const language = document.querySelector('#lang select');
      language.value = 'en';
      language.dispatchEvent(new Event('change'));
    });
    await waitFor(() => document.documentElement.lang === 'en');
    assert.equal(await run(() => typeof require), 'undefined');
    assert.ok(await run(() => !!document.querySelector('#viewer canvas')));
    const attempts = await run(async () => {
      const results = {};
      for (const url of ['https://example.com/', 'http://127.0.0.1:9/', 'https://nordiclayerlab.se/moldforge/app/']) {
        try { await fetch(url, { signal: AbortSignal.timeout(3000) }); results[url] = 'ALLOWED'; }
        catch { results[url] = 'blocked'; }
      }
      results.websocket = await new Promise(resolve => {
        try {
          const socket = new WebSocket('wss://example.com/');
          socket.onopen = () => { socket.close(); resolve('ALLOWED'); };
          socket.onerror = () => resolve('blocked');
          setTimeout(() => { socket.close(); resolve('blocked'); }, 3000);
        } catch { resolve('blocked'); }
      });
      results.worker = await new Promise(resolve => {
        const url = URL.createObjectURL(new Blob([
          "fetch('https://example.com/').then(() => postMessage('ALLOWED'), () => postMessage('blocked'))"
        ], { type: 'text/javascript' }));
        const worker = new Worker(url);
        const timer = setTimeout(() => finish('timeout'), 5000);
        function finish(result) {
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve(result);
        }
        worker.onmessage = event => finish(event.data);
        worker.onerror = () => finish('worker failed');
      });
      return results;
    });
    assert.ok(Object.values(attempts).every(x => x === 'blocked'));
    // Browser-side probes exercise CSP; session.fetch independently exercises the request blocker.
    let sessionBlocked = false;
    try { await ses.fetch('https://example.com/'); } catch { sessionBlocked = true; }
    assert.ok(sessionBlocked, 'session network request must fail');
    await run(() => document.querySelector('.samples button').click());
    await waitFor(() => document.querySelector('#empty-hint').hidden && document.querySelector('#busy').hidden);
    await waitFor(() => !!document.querySelector('.step-tab.done[aria-label="Export"]'));
    await run(() => document.querySelector('[aria-label="Export"]').click());
    const exported = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Export timed out')), 30000);
      ses.once('will-download', (_event, item) => {
        const target = path.join(temp, 'part.stl');
        item.setSavePath(target);
        item.once('done', async (_event, state) => {
          clearTimeout(timer);
          try {
            assert.equal(state, 'completed');
            const bytes = await readFile(target);
            assert.ok(bytes.length > 84);
            assert.equal(bytes.length, 84 + bytes.readUInt32LE(80) * 50, 'valid binary STL');
            resolve(bytes.length);
          } catch (error) { reject(error); }
        });
      });
    });
    await run(() => document.querySelector('button[title="Download STL"]').click());
    await exported;
    assert.equal(failures.length, 0);
    console.log('PASS: offline UI, sample import, geometry worker/WASM, STL export, and blocked network probes');
    await rm(temp, { recursive: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    await rm(temp, { recursive: true });
    app.exit(1);
  }
})().catch(error => { console.error(error); app.exit(1); });
