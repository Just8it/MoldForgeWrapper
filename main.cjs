const { readFile } = require('node:fs/promises');
const path = require('node:path');
const ORIGIN = 'moldforge://app';
const CSP = [
  "default-src 'none'",
  // Manifold's bundled WASM bindings generate JavaScript functions at runtime.
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"
].join('; ');
function isLocal(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'moldforge:' && parsed.host === 'app' && !parsed.username && !parsed.password;
  }
  catch { return false; }
}
function isAllowed(url) { return isLocal(url) || url.startsWith('blob:' + ORIGIN + '/') || url.startsWith('data:'); }
function assetPath(root, url) {
  if (!isLocal(url)) return null;
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    if (pathname.includes('\\') || pathname.includes('\0')) return null;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    return file.startsWith(path.resolve(root) + path.sep) ? file : null;
  } catch { return null; }
}

// The renderer receives no Node.js access or native bridge.
function start() {
  const { app, BrowserWindow, Menu, protocol, session, dialog } = require('electron');
  app.enableSandbox();
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-quic');
  app.commandLine.appendSwitch('dns-prefetch-disable');
  // A dead proxy and failed DNS resolution also cover Chromium background traffic.
  app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
  protocol.registerSchemesAsPrivileged([{ scheme: 'moldforge', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true
  } }]);

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json' };

  // Install on every session before a renderer can use it.
  app.on('session-created', ses => {
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowed(details.url) }));
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event, item) => {
      if (!item.getURL().startsWith('blob:' + ORIGIN + '/')) event.preventDefault();
      // Blob exports use Electron's native save dialog; no filesystem bridge is exposed.
    });
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => { if (!isLocal(event.url)) event.preventDefault(); });
    contents.on('will-frame-navigate', event => { if (!isLocal(event.url)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
  });

  const ready = app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const ses = session.fromPartition('persist:moldforge-offline');
    const root = path.join(__dirname, 'site');
    ses.protocol.handle('moldforge', async request => {
      const file = assetPath(root, request.url);
      if (!file || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      try {
        return new Response(await readFile(file), { headers: {
          'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'X-DNS-Prefetch-Control': 'off'
        } });
      } catch { return new Response('Not found', { status: 404 }); }
    });
    const win = new BrowserWindow({
      title: 'MoldForge Offline — network blocked', width: 1440, height: 960,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webviewTag: false, webSecurity: true, navigateOnDragDrop: false }
    });
    win.webContents.on('page-title-updated', event => event.preventDefault());
    await win.loadURL(ORIGIN + '/');
    return win;
  }).catch(error => {
    console.error(error);
    dialog.showErrorBox('MoldForge Offline could not start', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  return ready;
}

module.exports = { isLocal, isAllowed, assetPath };
// Plain Node tests load the rules without launching Electron.
if (process.versions.electron) module.exports.ready = start();
