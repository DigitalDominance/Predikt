// Minimal HTTP server for Heroku with deploy trigger.
//
// This server exposes a few diagnostic endpoints and a `/deploy` POST
// endpoint that will spawn the deployment script. The server also
// automatically runs the deployment script on startup if
// AUTO_DEPLOY_ON_START=true. This pattern mirrors the backend of the
// Insightra project and allows Heroku dynos to stay alive while
// performing asynchronous deployments.

const http = require('http');
const url = require('url');
const { spawn } = require('child_process');
const PORT = process.env.PORT || 3000;

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(body));
}

function runDeployOnce(script = 'scripts/deploy.js') {
  console.log('[DEPLOY] Launching child process:', script);
  const child = spawn('node', [script], { env: process.env });
  child.stdout.on('data', (d) => console.log('[DEPLOY OUT]', d.toString().trimEnd()));
  child.stderr.on('data', (d) => console.error('[DEPLOY ERR]', d.toString().trimEnd()));
  child.on('close', (code) => console.log('[DEPLOY] Child exited with code', code));
  return child;
}

function requireAuth(req) {
  const need = !!process.env.HEROKU_DEPLOY_TOKEN;
  if (!need) return true;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return token && token === process.env.HEROKU_DEPLOY_TOKEN;
}

const server = http.createServer((req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/healthz')) {
    return send(res, 200, { ok: true, service: 'predikt-oracle', time: new Date().toISOString() });
  }
  if (req.method === 'GET' && pathname === '/env') {
    const redact = (k) => ['PRIVATE_KEY', 'MNEMONIC', 'ALCHEMY_KEY', 'INFURA_KEY', 'HEROKU_DEPLOY_TOKEN'].includes(k);
    const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, redact(k) ? '***' : v]));
    return send(res, 200, { ok: true, env });
  }
  if (req.method === 'GET' && pathname === '/version') {
    return send(res, 200, { name: process.env.npm_package_name || 'oracle', version: process.env.npm_package_version || '0.0.0' });
  }
  if (req.method === 'POST' && pathname === '/deploy') {
    if (!requireAuth(req)) return send(res, 401, { ok: false, error: 'Unauthorized' });
    const script = (query && query.script) || 'scripts/deploy.js';
    runDeployOnce(script);
    return send(res, 202, { ok: true, msg: 'Deploy started', script });
  }

  return send(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, () => {
  console.log(`[predikt-oracle] listening on :${PORT}`);
  if (String(process.env.AUTO_DEPLOY_ON_START || 'false').toLowerCase() === 'true') {
    console.log('🚀 Starting deployment script on app startup (non-blocking)...');
    runDeployOnce('scripts/deploy.js');
  } else {
    console.log('AUTO_DEPLOY_ON_START is false — not deploying on boot.');
  }
});