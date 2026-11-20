// License server — the one place YOU (the vendor) manage every restaurant's subscription.
// No npm install needed. Node.js 18+ required. Run: node server.js
//
// Each restaurant's cafe-system copy has, in its own config.json, a "licenseUrl" that
// points here: https://<where-this-is-hosted>/api/status/<their id>
// Every few hours it fetches that URL and locks itself if this server says to.
//
// You manage everyone from the admin dashboard at /admin (password-protected).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const PORT = +process.env.PORT || +CFG.port || 4000;
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || CFG.adminPassword || 'changeme');
// DATA_DIR lets this point at a persistent disk (e.g. Render's /data) instead of the
// app folder, so the license records survive restarts/redeploys on hosts with an
// ephemeral filesystem. Defaults to this folder for plain local use.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA = path.join(DATA_DIR, 'licenses.json');
const PUBLIC = path.join(__dirname, 'public');

if (ADMIN_PASSWORD === 'changeme' || ADMIN_PASSWORD === 'changeme123') {
  console.log('\n  WARNING: you are still using the starting admin password. Change "adminPassword" in config.json.\n');
}

function load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return { clients: {} }; } }
function persist(d) { try { fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); } catch (e) { console.error('Save failed:', e.message); } }
let DB = load();
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(DB), 150); }

const newId = () => crypto.randomBytes(6).toString('base64url'); // short, URL-safe, hard to guess
const fail = m => { const e = new Error(m); e.user = true; throw e; };
function addMonths(iso, months) { const d = new Date(iso); d.setMonth(d.getMonth() + months); return d.toISOString(); }
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

// What the restaurant's software receives — no internal fields, no other restaurants' data.
function publicView(c) { return { active: c.active, expiresAt: c.expiresAt, message: c.message || null }; }

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }

  // ---- Public endpoint: this is what every restaurant's cafe-system polls ----
  const m = u.pathname.match(/^\/api\/status\/([A-Za-z0-9_-]{4,40})$/);
  if (m && req.method === 'GET') {
    const c = DB.clients[m[1]];
    if (!c) return json(res, 404, { active: false, message: 'License not recognized. Please contact support.' });
    return json(res, 200, publicView(c));
  }

  // ---- Admin: check password ----
  if (u.pathname === '/api/admin/ping' && req.method === 'GET') {
    const ok = u.searchParams.get('password') === ADMIN_PASSWORD;
    return json(res, ok ? 200 : 403, { ok });
  }

  // ---- Admin: list all clients ----
  if (u.pathname === '/api/admin/list' && req.method === 'GET') {
    if (u.searchParams.get('password') !== ADMIN_PASSWORD) return json(res, 403, { error: 'Wrong password' });
    const list = Object.entries(DB.clients).map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return json(res, 200, { clients: list });
  }

  // ---- Admin: add / renew / pause / resume / message / delete ----
  if (u.pathname === '/api/admin/action' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        if (b.password !== ADMIN_PASSWORD) return json(res, 403, { error: 'Wrong password' });
        let out = {};
        switch (b.op) {
          case 'add': {
            const name = String(b.name || '').trim().slice(0, 80);
            if (!name) fail('Enter a restaurant name');
            const months = Math.max(1, Math.min(60, +b.months || 6));
            const startedAt = new Date().toISOString();
            const id = newId();
            DB.clients[id] = { name, active: true, startedAt, expiresAt: addMonths(startedAt, months),
              plan: months, message: '', history: [{ at: startedAt, event: 'created', months }] };
            out = { id };
            break;
          }
          case 'renew': {
            const c = DB.clients[b.id]; if (!c) fail('Client not found');
            const months = Math.max(1, Math.min(60, +b.months || 1));
            // Renewing early keeps whatever time is left and adds to it, rather than wasting it.
            const base = (c.expiresAt && new Date(c.expiresAt).getTime() > Date.now()) ? c.expiresAt : new Date().toISOString();
            c.expiresAt = addMonths(base, months); c.active = true; c.plan = months;
            c.history.push({ at: new Date().toISOString(), event: 'renewed', months });
            out = { expiresAt: c.expiresAt };
            break;
          }
          case 'pause': {
            const c = DB.clients[b.id]; if (!c) fail('Client not found');
            c.active = false; c.history.push({ at: new Date().toISOString(), event: 'paused' });
            break;
          }
          case 'resume': {
            const c = DB.clients[b.id]; if (!c) fail('Client not found');
            c.active = true; c.history.push({ at: new Date().toISOString(), event: 'resumed' });
            break;
          }
          case 'message': {
            const c = DB.clients[b.id]; if (!c) fail('Client not found');
            c.message = String(b.message || '').slice(0, 300);
            break;
          }
          case 'rename': {
            const c = DB.clients[b.id]; if (!c) fail('Client not found');
            const name = String(b.name || '').trim().slice(0, 80); if (!name) fail('Enter a name');
            c.name = name;
            break;
          }
          case 'delete': {
            if (!DB.clients[b.id]) fail('Client not found');
            delete DB.clients[b.id];
            break;
          }
          default: fail('Unknown operation');
        }
        save();
        json(res, 200, { ok: true, ...out });
      } catch (e) { json(res, e.user ? 400 : 500, { error: e.user ? e.message : 'Server error' }); if (!e.user) console.error(e); }
    });
    return;
  }

  // ---- static admin page ----
  let p = (u.pathname === '/' || u.pathname === '/admin') ? '/admin.html' : u.pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log('\nPort ' + PORT + ' is already in use.\n');
  else console.log('\nCould not start: ' + e.message + '\n');
  process.exit(1);
});
server.listen(PORT, () => {
  console.log('\nLicense server running.');
  console.log('  Admin dashboard: http://localhost:' + PORT + '/admin');
  console.log('  Restaurants check in at: http://<this-server-public-address>/api/status/<their id>\n');
});
