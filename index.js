const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) { try { Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'production', tracesSampleRate: 0 }); console.log('Sentry enabled'); } catch (e) { console.error('Sentry init failed:', e.message); } }
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const session = require('express-session');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./lib/auth');
const { validateNoTemplateChars } = require('./lib/validate');
const { buildPeopleStructures } = require('./lib/people');
const { buildProductStructures } = require('./lib/products');
const { validatePersonInput, computeCapabilityCells } = require('./lib/people-admin');
const { buildTradingBreakdown, buildCoverage } = require('./lib/stats');
const { dedupeIds, partitionSelection } = require('./lib/bulk');
const { validateNewRequest, canClaim, canCancel, canApprove, buildBoard, replaceNameInCell } = require('./lib/swaps');
const { parseShiftsCsv } = require('./lib/csvimport');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Render reverse proxy

// gzip all responses — the dashboard HTML is ~1.3 MB uncompressed; gzip cuts the transfer ~10x
const compression = require('compression');
app.use(compression());

// --- Bezpecnostni hlavicky (na vsech odpovedich) ---
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' https:",
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"
    ].join('; '));
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// --- Rate limiting (in-memory, per-IP; bez extra zavislosti) ---
function makeRateLimiter({ max, windowMs, message }) {
    const hits = new Map();
    const t = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k); }, windowMs);
    if (t.unref) t.unref();
    const mw = (req, res, next) => {
        const ip = req.ip || 'unknown';
        const now = Date.now();
        let rec = hits.get(ip);
        if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + windowMs }; hits.set(ip, rec); }
        rec.count++;
        if (rec.count > max) {
            res.setHeader('Retry-After', Math.ceil((rec.resetAt - now) / 1000));
            return res.status(429).send((message || 'Too many requests.') + ' (' + Math.ceil((rec.resetAt - now) / 60000) + ' min)');
        }
        next();
    };
    mw.reset = (req) => { hits.delete(req.ip || 'unknown'); };
    return mw;
}
const loginLimiter = makeRateLimiter({ max: 10, windowMs: 15 * 60 * 1000, message: 'Too many login attempts, please try again later.' });

const COOKIE_SECRET = process.env.SESSION_SECRET || 'drachir-viking-secret-2026';
app.use(session({
    secret: COOKIE_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' }
}));

// CSRF: zajisti token v session
app.use((req, res, next) => {
    if (req.session && !req.session.csrf) {
        req.session.csrf = crypto.randomBytes(32).toString('hex');
    }
    next();
});

// Remember me helpers — HMAC-signed token
function makeRememberToken(user) {
    const data = Buffer.from(JSON.stringify(user)).toString('base64');
    const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
    return data + '.' + sig;
}
function verifyRememberToken(token) {
    if (!token || !token.includes('.')) return null;
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    try { return JSON.parse(Buffer.from(data, 'base64').toString()); } catch(e) { return null; }
}

// Obnov uzivatele ze session NEBO z remember cookie
function getUser(req) {
    if (req.session && req.session.user) return req.session.user;
    const raw = req.headers.cookie || '';
    const match = raw.split(';').map(c=>c.trim()).find(c=>c.startsWith('remember_token='));
    if (match) {
        const val = decodeURIComponent(match.substring('remember_token='.length));
        const user = verifyRememberToken(val);
        if (user) {
            if (req.session) req.session.user = user;
            return user;
        }
    }
    return null;
}
// Middleware: nastav req.user z tokenu pro kazdy request
app.use((req, res, next) => {
    req.user = getUser(req);
    next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// CSRF: ověř token na všech stav-měnících requestech
const CSRF_EXEMPT = new Set(['/login']); // login probíhá bez existující session
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (CSRF_EXEMPT.has(req.path)) return next();
    const sent = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
    if (!req.session || !req.session.csrf || sent !== req.session.csrf) {
        return res.status(403).send('CSRF token invalid');
    }
    next();
});
app.use(express.static('public'));

// ====== Platform: health check + ICS kalendarovy feed ======
function icsTokenForName(name) {
    return crypto.createHmac('sha256', COOKIE_SECRET).update('ics:' + name).digest('hex').slice(0, 32);
}
function icsEscape(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function buildIcs(name, shifts) {
    const pad = n => String(n).padStart(2, '0');
    const fmt = (dateStr, timeStr) => {
        const [y, m, d] = dateStr.split('-');
        const [hh, mm] = timeStr.split(':');
        return y + m + d + 'T' + pad(hh) + pad(mm) + '00';
    };
    const nextDay = (dateStr) => { const dd = new Date(dateStr + 'T12:00:00'); dd.setDate(dd.getDate() + 1); return dd.toISOString().slice(0, 10); };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//drachir.gg//calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'X-WR-CALNAME:' + icsEscape('Drachir - ' + name), 'X-WR-TIMEZONE:Europe/Prague'];
    shifts.forEach((s, i) => {
        const endDate = (s.End < s.Start) ? nextDay(s.Date) : s.Date;   // overnight smeny
        const uid = (s._sheet ? (s._sheet + '-' + s._row + '-' + s._col) : (s.Date + '-' + s.Product + '-' + s.Start + '-' + i)).replace(/\s+/g, '_') + '@drachir.gg';
        out.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp,
            'DTSTART:' + fmt(s.Date, s.Start), 'DTEND:' + fmt(endDate, s.End),
            'SUMMARY:' + icsEscape(s.Product || s.Trading || 'Shift'),
            'DESCRIPTION:' + icsEscape((s.Trading || '') + (s.Note ? (' - ' + s.Note) : '')),
            'END:VEVENT');
    });
    out.push('END:VCALENDAR');
    return out.join('\r\n') + '\r\n';
}

// Health check (verejny) - monitoring/uptime
app.get('/healthz', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        shiftsCached: Array.isArray(_shiftsCache) ? _shiftsCache.length : 0,
        cacheAgeSec: _shiftsCacheTime ? Math.round((Date.now() - _shiftsCacheTime) / 1000) : null,
        people: peopleHierarchy ? peopleHierarchy.reduce((a, g) => a + g.members.length, 0) : 0,
        products: Array.isArray(productMapping) ? productMapping.length : 0,
        ts: new Date().toISOString()
    });
});

// Real-time SSE stream (authed) - klient dostane udalost "changed" pri kazde zmene dat
app.get('/events', (req, res) => {
    if (!req.user) return res.status(401).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 5000\n\n');
    res.write(': connected\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ICS feed (token-authed, bez loginu) - napojeni do Google/Apple/Outlook kalendare
app.get('/calendar/:token/feed.ics', async (req, res) => {
    try {
        const token = (req.params.token || '').toLowerCase();
        const names = peopleHierarchy.flatMap(g => g.members);
        const name = names.find(n => icsTokenForName(n) === token);
        if (!name) return res.status(404).send('Invalid calendar token');
        const all = await loadAllShifts();
        const mine = all.filter(s => s.Name === name).sort((a, b) => (a.Date + a.Start).localeCompare(b.Date + b.Start));
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="drachir.ics"');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(buildIcs(name, mine));
    } catch (e) {
        console.error('[ICS] error:', e.message);
        res.status(500).send('Calendar error');
    }
});

// Page s osobni adresou kalendare (authed)
app.get('/calendar', (req, res) => {
    if (!req.user) return res.redirect('/');
    const token = icsTokenForName(req.user.jmeno);
    const url = req.protocol + '://' + req.get('host') + '/calendar/' + token + '/feed.ics';
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My calendar (ICS)</title>
<style>body{margin:0;background:#0f1320;color:#c8d0e0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;justify-content:center;padding:40px 16px;}
.card{max-width:680px;width:100%;background:#161b2c;border:1px solid rgba(165,180,252,0.16);border-radius:14px;padding:28px;}
h1{font-size:1.4rem;margin:0 0 6px;color:#a78bfa;}p{color:#8892a4;line-height:1.6;font-size:0.92rem;}
.url{display:flex;gap:8px;margin:18px 0;}input{flex:1;background:#0a0b0f;border:1px solid #2a3a60;border-radius:8px;color:#c0d4e8;padding:11px 12px;font-size:0.82rem;font-family:monospace;}
.url button{background:rgba(167,139,250,0.14);border:1px solid rgba(167,139,250,0.4);color:#a78bfa;border-radius:8px;padding:0 16px;font-weight:700;cursor:pointer;}
ol{color:#8892a4;line-height:1.9;font-size:0.9rem;}a.back{color:#5b7fa6;text-decoration:none;font-size:0.85rem;}</style></head>
<body><div class="card">
<a class="back" href="/dashboard">&#8592; Back to calendar</a>
<h1>&#128197; My calendar (ICS)</h1>
<p>Subscribe to your shifts directly in Google / Apple / Outlook calendar. This URL is personal (it contains a signing token) &mdash; do not share it. The calendar updates automatically.</p>
<div class="url"><input id="u" readonly value="${url}"><button onclick="navigator.clipboard.writeText(document.getElementById('u').value);this.textContent='Copied'">Copy</button></div>
<ol>
<li><b>Google Calendar:</b> left sidebar &bdquo;Other calendars&ldquo; &rarr; <b>+</b> &rarr; &bdquo;From URL&ldquo; &rarr; paste the URL.</li>
<li><b>Apple Calendar:</b> File &rarr; New Calendar Subscription &rarr; paste the URL.</li>
<li><b>Outlook:</b> Add calendar &rarr; Subscribe from web &rarr; paste the URL.</li>
</ol>
<p style="font-size:0.8rem;color:#5b6478;">The app pulls the feed every few dozen minutes &mdash; shift changes appear automatically.</p>
</div></body></html>`);
});

let googleKeys;
if (process.env.GOOGLE_CREDENTIALS) {
    googleKeys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} else {
    try { googleKeys = require('./credentials.json'); } catch (e) { console.error("Credentials missing!"); }
}

const serviceAccountAuth = new JWT({
    email: googleKeys.client_email,
    key: googleKeys.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet('17iOEaSnL0ZxKYXCFiIuJkWoSbnB3INx1Ust0fBnLVg4', serviceAccountAuth);

// ===== Web Push (env-gated VAPID; silently no-ops without keys, like Slack/Bamboo) =====
let webpush = null;
try { webpush = require('web-push'); } catch (e) {}
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const PUSH_ENABLED = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_ENABLED) { try { webpush.setVapidDetails('mailto:david.kuchar@oddin.gg', VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) { console.error('VAPID init failed:', e.message); } }
async function getPushSheet() {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['PushSubs'];
    if (!sheet) sheet = await doc.addSheet({ title: 'PushSubs', headerValues: ['Jmeno', 'Email', 'Endpoint', 'Sub', 'CreatedAt'] });
    return sheet;
}
async function sendPushToUser(jmeno, title, body, url) {
    if (!PUSH_ENABLED || !jmeno) return;
    try {
        const sheet = await getPushSheet();
        const rows = await sheet.getRows();
        for (const r of rows.filter(r => (r.get('Jmeno') || '') === jmeno)) {
            try { await webpush.sendNotification(JSON.parse(r.get('Sub')), JSON.stringify({ title: title, body: body, url: url || '/dashboard' })); }
            catch (e) { if (e.statusCode === 410 || e.statusCode === 404) { try { await r.delete(); } catch (_) {} } }
        }
    } catch (e) { console.error('push send failed:', e.message); }
}
// ===== In-app notifications (bell) — persistent per-user, shown when they next open the app =====
async function getNotifSheet() {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['Notifications'];
    if (!sheet) sheet = await doc.addSheet({ title: 'Notifications', headerValues: ['Jmeno', 'Text', 'Url', 'CreatedAt', 'Read'] });
    return sheet;
}
async function addNotification(jmeno, text, url) {
    if (!jmeno || !text) return;
    try { const sheet = await getNotifSheet(); await sheet.addRow({ Jmeno: jmeno, Text: text, Url: url || '/dashboard', CreatedAt: new Date().toISOString(), Read: 'false' }, { raw: true }); }
    catch (e) { console.error('notification add failed:', e.message); }
}

// --- CACHE (platna 2 minuty) ---
let _shiftsCache = null;
let _shiftsCacheTime = 0;
let _hiddenSheets = new Set(); // Sheety skryte pres "Delete All Shifts This Month"
const CACHE_TTL = 5 * 60 * 1000; // 5 minut

function isCacheValid() {
    return _shiftsCache && (Date.now() - _shiftsCacheTime < CACHE_TTL);
}
function setCache(data) {
    _shiftsCache = data;
    _shiftsCacheTime = Date.now();
}

// --- Real-time: SSE broadcast pri zmene dat (napojeno na invalidateCache = univerzalni write hook) ---
const sseClients = new Set();
function broadcastChange(reason) {
    const payload = 'event: changed\ndata: ' + JSON.stringify({ ts: Date.now(), reason: reason || 'update' }) + '\n\n';
    for (const r of sseClients) { try { r.write(payload); } catch (e) { sseClients.delete(r); } }
}
function invalidateCache() {
    _shiftsCache = null;
    _shiftsCacheTime = 0;
    broadcastChange();
}


// BOD 1: SLACK NOTIFIKACE
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

async function sendSlackMessage(text) {
    if (!SLACK_WEBHOOK_URL) return;
    try {
        const https = require('https');
        const body = JSON.stringify({ text });
        const url = new URL(SLACK_WEBHOOK_URL);
        return new Promise((resolve) => {
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, res => { res.on('data', () => {}); res.on('end', resolve); });
            req.on('error', e => console.error('Slack error:', e.message));
            req.write(body);
            req.end();
        });
    } catch(e) { console.error('Slack send error:', e.message); }
}

// Slack DM via Bot Token (chat.postMessage)
async function sendSlackDM(slackUserId, text) {
    if (!SLACK_BOT_TOKEN || !slackUserId) return;
    try {
        const https = require('https');
        const body = JSON.stringify({ channel: slackUserId, text, unfurl_links: false });
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'slack.com',
                path: '/api/chat.postMessage',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN, 'Content-Length': Buffer.byteLength(body) }
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { const j = JSON.parse(data); if (!j.ok) console.error('Slack DM error:', j.error); } catch(e) {}
                    resolve();
                });
            });
            req.on('error', e => console.error('Slack DM error:', e.message));
            req.write(body);
            req.end();
        });
    } catch(e) { console.error('Slack DM send error:', e.message); }
}

// Slack ID map (jmeno -> slack_id) and subscriptions cache
let _slackIdMap = {};
let _slackSubscriptions = [];
let _slackDataLoaded = false;

async function loadSlackData() {
    try {
        await doc.loadInfo();
        // Load slack_id from uzivatele
        const uzSheet = doc.sheetsByTitle['uzivatele'];
        if (uzSheet) {
            await uzSheet.loadCells('A1:Z200');
            let colJmeno = -1, colSlackId = -1;
            for (let c = 0; c < 15; c++) {
                const v = uzSheet.getCell(0, c).value?.toString().trim().toLowerCase();
                if (v === 'jmeno') colJmeno = c;
                if (v === 'slack_id') colSlackId = c;
            }
            if (colJmeno >= 0 && colSlackId >= 0) {
                const map = {};
                for (let r = 1; r < Math.min(uzSheet.rowCount, 200); r++) {
                    const name = uzSheet.getCell(r, colJmeno).value?.toString().trim();
                    const sid = uzSheet.getCell(r, colSlackId).value?.toString().trim();
                    if (name && sid) map[name] = sid;
                }
                _slackIdMap = map;
                console.log('Loaded Slack IDs for', Object.keys(map).length, 'users');
            }
        }
        // Load subscriptions from SlackSubscriptions sheet
        const subSheet = doc.sheetsByTitle['SlackSubscriptions'];
        if (subSheet) {
            await subSheet.loadCells('A1:B500');
            let colSub = -1, colTarget = -1;
            for (let c = 0; c < 5; c++) {
                const v = subSheet.getCell(0, c).value?.toString().trim().toLowerCase();
                if (v === 'subscriber') colSub = c;
                if (v === 'target') colTarget = c;
            }
            if (colSub >= 0 && colTarget >= 0) {
                const subs = [];
                for (let r = 1; r < Math.min(subSheet.rowCount, 500); r++) {
                    const subscriber = subSheet.getCell(r, colSub).value?.toString().trim();
                    const target = subSheet.getCell(r, colTarget).value?.toString().trim();
                    if (subscriber && target) subs.push({ subscriber, target });
                }
                _slackSubscriptions = subs;
                console.log('Loaded', subs.length, 'Slack subscriptions');
            }
        }
        _slackDataLoaded = true;
    } catch(e) { console.error('Error loading Slack data:', e.message); }
}

// Lima members (CET -6h) — get dual-timezone suffix in messages
// LIMA: odvozeno ze skupiny "Traders - Lima" (viz limaSet nize)

function shiftLimaTime(hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
    const [h, m] = hhmm.split(':').map(Number);
    const lh = ((h - 6) % 24 + 24) % 24;
    return String(lh).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

function withLimaSuffix(name, details, start, end) {
    if (!limaSet.has(name) || !start || !end) return details;
    return details + ' — Lima: ' + shiftLimaTime(start) + '-' + shiftLimaTime(end);
}

async function notifyShiftChange(actionBy, targetName, verb, details, start, end) {
    // Web push to the affected person (independent of Slack)
    try { if (targetName && targetName !== actionBy) addNotification(targetName, actionBy + ' ' + verb + ' your shift: ' + details + (start ? ' (' + start + '-' + end + ')' : ''), '/dashboard'); } catch (e) {}
    if (!SLACK_BOT_TOKEN) return;
    if (!_slackDataLoaded) await loadSlackData();
    const promises = [];
    // 1. DM to person who made the change
    const actionBySlack = _slackIdMap[actionBy];
    if (actionBySlack) {
        const msg = withLimaSuffix(actionBy, details, start, end);
        promises.push(sendSlackDM(actionBySlack, ':pencil2: You ' + verb + ' a shift: ' + msg));
    }
    // 2. DM to person whose shift was changed (if different)
    if (targetName && targetName !== actionBy) {
        const targetSlack = _slackIdMap[targetName];
        if (targetSlack) {
            const msg = withLimaSuffix(targetName, details, start, end);
            promises.push(sendSlackDM(targetSlack, ':bell: ' + actionBy + ' ' + verb + ' your shift: ' + msg));
        }
    }
    // 3. DM to all subscribers watching targetName
    if (targetName) {
        const subs = _slackSubscriptions.filter(s => s.target === targetName && s.subscriber !== actionBy && s.subscriber !== targetName);
        for (const sub of subs) {
            const subSlack = _slackIdMap[sub.subscriber];
            if (subSlack) {
                const msg = withLimaSuffix(sub.subscriber, details, start, end);
                promises.push(sendSlackDM(subSlack, ':eyes: ' + actionBy + ' ' + verb + ' ' + targetName + "'s shift: " + msg));
            }
        }
    }
    await Promise.allSettled(promises);
}

// --- BAMBOO HR VACATION SYNC ---
const BAMBOOHR_API_KEY   = process.env.BAMBOOHR_API_KEY   || '';
const BAMBOOHR_SUBDOMAIN = process.env.BAMBOOHR_SUBDOMAIN || '';

function bambooRequest(path) {
    return new Promise((resolve, reject) => {
        if (!BAMBOOHR_API_KEY || !BAMBOOHR_SUBDOMAIN) {
            return reject(new Error('BambooHR not configured'));
        }
        const https = require('https');
        const auth = Buffer.from(BAMBOOHR_API_KEY + ':x').toString('base64');
        const req = https.request({
            hostname: 'api.bamboohr.com',
            path: '/api/gateway.php/' + BAMBOOHR_SUBDOMAIN + path,
            method: 'GET',
            headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error('Bamboo HTTP ' + res.statusCode + ': ' + data.slice(0,200)));
                try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Bamboo JSON parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

let _lastBambooSync = 0;
const BAMBOO_SYNC_MIN_INTERVAL = 30 * 1000; // 30s throttle

async function syncBambooVacations(forceIgnoreThrottle) {
    if (!BAMBOOHR_API_KEY || !BAMBOOHR_SUBDOMAIN) {
        console.log('[BAMBOO] Skipped — not configured');
        return { added: 0, removed: 0, skipped: 'not-configured' };
    }
    if (!forceIgnoreThrottle && (Date.now() - _lastBambooSync) < BAMBOO_SYNC_MIN_INTERVAL) {
        console.log('[BAMBOO] Skipped — throttled (<30s since last sync)');
        return { added: 0, removed: 0, skipped: 'throttled' };
    }
    _lastBambooSync = Date.now();
    try {
        // Window: 14 days back, 180 days forward
        const today = new Date();
        const startD = new Date(today); startD.setDate(startD.getDate() - 14);
        const endD   = new Date(today); endD.setDate(endD.getDate() + 180);
        const startStr = toISOLocal(startD);
        const endStr   = toISOLocal(endD);

        // 1. Directory (employeeId -> workEmail)
        const dir = await bambooRequest('/v1/employees/directory');
        const emailById = {};
        (dir.employees || []).forEach(emp => {
            const e = (emp.workEmail || '').toString().trim().toLowerCase();
            if (e) emailById[String(emp.id)] = e;
        });
        console.log('[BAMBOO] Directory: ' + Object.keys(emailById).length + ' employees w/ email');

        // 2. Approved time-off requests in window
        const requests = await bambooRequest('/v1/time_off/requests?status=approved&start=' + startStr + '&end=' + endStr);
        console.log('[BAMBOO] Got ' + (requests.length || 0) + ' approved requests');

        // 3. uzivatele (email -> jmeno) — only our team
        await doc.loadInfo();
        const uzSheet = doc.sheetsByTitle['uzivatele'];
        if (!uzSheet) { console.log('[BAMBOO] No uzivatele sheet'); return { added: 0, removed: 0 }; }
        await uzSheet.loadCells('A1:Z500');
        let colJmeno = -1, colEmail = -1;
        for (let c = 0; c < 15; c++) {
            const v = uzSheet.getCell(0, c).value?.toString().trim().toLowerCase();
            if (v === 'jmeno') colJmeno = c;
            if (v === 'email') colEmail = c;
        }
        if (colJmeno < 0 || colEmail < 0) { console.log('[BAMBOO] uzivatele missing jmeno/email'); return { added: 0, removed: 0 }; }
        const jmenoByEmail = {};
        for (let r = 1; r < Math.min(uzSheet.rowCount, 500); r++) {
            const em = uzSheet.getCell(r, colEmail).value?.toString().trim().toLowerCase();
            const jm = uzSheet.getCell(r, colJmeno).value?.toString().trim();
            if (em && jm) jmenoByEmail[em] = jm;
        }
        console.log('[BAMBOO] uzivatele mapped: ' + Object.keys(jmenoByEmail).length);

        // 4. ManualShifts sheet
        let manualSheet = doc.sheetsByTitle['ManualShifts'];
        if (!manualSheet) {
            manualSheet = await doc.addSheet({ title: 'ManualShifts', headerValues: ['Date','Name','Trading','Product','Start','End','Note','AddedBy'] });
        }
        const rows = await manualSheet.getRows();

        // 5. Delete existing BambooHR rows in our window (in reverse to keep indices stable)
        let removed = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i];
            if ((r.get('AddedBy') || '').toString().trim() !== 'BambooHR') continue;
            const d = convertCzechDate(r.get('Date') || '');
            if (d && d >= startStr && d <= endStr) {
                try { await r.delete(); removed++; } catch(e) { console.error('[BAMBOO] delete err:', e.message); }
            }
        }
        console.log('[BAMBOO] Removed ' + removed + ' stale rows');

        // 6. Build dedup set of manual (non-Bamboo) rows for "Vacation" product
        const freshRows = await manualSheet.getRows();
        const manualKeys = new Set();
        freshRows.forEach(r => {
            if ((r.get('AddedBy') || '').toString().trim() === 'BambooHR') return;
            const d = convertCzechDate(r.get('Date') || '');
            const n = (r.get('Name') || '').toString().trim();
            const p = (r.get('Product') || '').toString().trim();
            if (d && n && p === 'Vacation') manualKeys.add(d + '|' + n);
        });

        // 7. Expand each request to per-day rows and batch-insert
        const newRows = [];
        for (const req of (requests || [])) {
            const empId = String(req.employeeId || '');
            const email = emailById[empId];
            if (!email) continue;
            const jmeno = jmenoByEmail[email];
            if (!jmeno) continue; // not our team — skip silently
            const typeName = (req.type && req.type.name) ? req.type.name : 'Time Off';
            const empNote  = (req.notes && req.notes.employee) ? req.notes.employee.toString().slice(0,120) : '';
            const note = 'BambooHR: ' + typeName + (empNote ? ' — ' + empNote : '');
            const datesObj = req.dates || {};
            Object.keys(datesObj).forEach(dateStr => {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
                if (dateStr < startStr || dateStr > endStr) return;
                const amt = parseFloat(datesObj[dateStr]);
                if (!(amt > 0)) return;
                if (manualKeys.has(dateStr + '|' + jmeno)) return; // manual row wins
                newRows.push({
                    Date:    dateStr,
                    Name:    jmeno,
                    Trading: 'HR',
                    Product: 'Vacation',
                    Start:   '00:00',
                    End:     '23:59',
                    Note:    note,
                    AddedBy: 'BambooHR'
                });
            });
        }
        if (newRows.length > 0) {
            try { await manualSheet.addRows(newRows); }
            catch(e) { console.error('[BAMBOO] addRows err:', e.message); }
        }
        console.log('[BAMBOO] Added ' + newRows.length + ' vacation rows');
        return { added: newRows.length, removed };
    } catch(e) {
        console.error('[BAMBOO] Sync error:', e.message);
        return { added: 0, removed: 0, error: e.message };
    }
}

// --- BOD 5: INDIVIDUÁLNÍ BARVY KAŽDÉHO ČLOVĚKA ---
const SEED_PERSON_COLORS = {
    "David Winkler":          "#fbc02d",
    "Ondřej Merxbauer":       "#00bcd4",
    "David Kuchař":           "#e91e63",
    "Lukáš Novotný":          "#4caf50",
    "Filip Sklenička":        "#009688",
    "Jindřich Lacina":  "#00897b",
    "David Trocino":          "#43a047",
    "David Lamač":            "#66bb6a",
    "Tomáš Komenda":          "#26a69a",
    "Dominik Chvátal":        "#2e7d32",
    "Marcelo Goto":           "#558b2f",
    "Adam Zach":              "#9c27b0",
    "Andrej Rybalka":         "#7b1fa2",
    "Ivan Čitári":            "#8e24aa",
    "Jan Bouška":             "#ab47bc",
    "Jan Kubelka":            "#ba68c8",
    "Kevin Rojas":            "#6a1b9a",
    "Ladislav Bánský":        "#4a148c",
    "Richard Mojš":           "#7c4dff",
    "Robert Šobíšek":         "#651fff",
    "Vojtěch Malár":          "#d500f9",
    "Benjamin Drzymalla":     "#aa00ff",
    "Denis M.":               "#1976d2",
    "Jakub K.":               "#1565c0",
    "Jan K.":                 "#0288d1",
    "Jiří K.":                "#0277bd",
    "Lukáš T.":               "#0097a7",
    "Marek M.":               "#00838f",
    "Martin J.":              "#006064",
    "Martin N.":              "#1e88e5",
    "Matěj K.":               "#039be5",
    "Matyáš P.":              "#0091ea",
    "Michal F.":              "#2196f3",
    "Michal P.":              "#42a5f5",
    "Michal W.":              "#5c6bc0",
    "Patrik Ř.":              "#3949ab",
    "Petr H.":                "#303f9f",
    "Petr R.":                "#283593",
    "Przemyslaw K.":          "#0d47a1",
    "Sebastián W.":           "#1a237e",
    "Stanislav U.":           "#64b5f6",
    "Tadeáš F.":              "#4fc3f7",
    "Tomáš M.":               "#81d4fa",
    "Viet":                   "#29b6f6",
    "Adrian M.":              "#ff7043",
    "Andres":                 "#ff5722",
    "Christian C.":            "#f4511e",
    "David Z.":               "#e64a19",
    "Flabio T.":              "#bf360c",
    "Francesco":              "#ff6d00",
    "Franco M.":              "#ff8f00",
    "Gustavo P.":             "#f57c00",
    "Hadi B.":                "#ef6c00",
    "James H.":               "#e65100",
    "Jose C.":                "#dd2c00",
    "Martin M. M.":           "#ff3d00",
    "Santiago B.":            "#ff6e40",
    "William M.":             "#ff9e80"
};

const PRODUCT_COLORS_SEED = {
    "Valhalla Cup A":  "#f44336",
    "Valhalla Cup B":  "#ff5722",
    "Valhalla Cup C":  "#ff9800",
    "Valkyrie Cup A":  "#ffc107",
    "Valkyrie Cup B":  "#cddc39",
    "Valhalla League": "#2196f3",
    "Yodha League":    "#4caf50",
    "CS 2 Duels":      "#9c27b0",
    "Dota 2 Duels":    "#673ab7",
    "Madden":          "#795548",
    "Table Tennis":    "#00bcd4",
    "World of Tanks":  "#607d8b",
    "eHockey":         "#e91e63",
};

// --- SDÍLENÁ DATA (dashboard + stats) ---
const SEED_HIERARCHY = [
    { label: "Head of Trading - eSims", color: "#fbc02d", target: 0,  members: ["David Winkler"] },
    { label: "Quality Assurance",       color: "#03a9f4", target: 16, members: ["Ondřej Merxbauer"] },
    { label: "Master Scheduler",        color: "#e91e63", target: 24, members: ["David Kuchař"] },
    { label: "Team Leaders",            color: "#4caf50", target: 20, members: ["Lukáš Novotný", "Filip Sklenička", "Jindřich Lacina", "David Trocino", "David Lamač", "Tomáš Komenda", "Dominik Chvátal", "Marcelo Goto"] },
    { label: "Title Experts",           color: "#9c27b0", target: 24, members: ["Adam Zach", "Andrej Rybalka", "Ivan Čitári", "Jan Bouška", "Jan Kubelka", "Matěj Kos", "Ladislav Bánský", "Richard Mojš", "Robert Šobíšek", "Vojtěch Malár", "Benjamin Drzymalla", "Patrik Říčka", "Martin Jílek"] },
    { label: "Traders - Europe",        color: "#8bc34a", target: 40, members: ["Denis M.", "Ivan", "Jakub K.", "Jan K.", "Jiří K.", "Lukáš T.", "Marek M.", "Martin N.", "Matyáš P.", "Michal F.", "Michal P.", "Michal W.", "Petr H.", "Petr R.", "Przemyslaw K.", "Sebastián W.", "Stanislav U.", "Tadeáš F.", "Tomáš M.", "Viet"] },
    { label: "Traders - Lima",          color: "#ff5722", target: 40, members: ["Adrian M.", "Andres", "Christian C.", "David Z.", "Flabio T.", "Francesco", "Franco M.", "Gustavo P.", "Hadi B.", "James H.", "Jose C.", "Martin M. M.", "Santiago B.", "William M.", "Kevin R."] }
];

// --- Lide: live struktury (seed = fallback; pri startu/refreshe prepsane z listu "People") ---
const GROUPS = SEED_HIERARCHY.map(({ label, color, target }) => ({ label, color, target }));
const PEOPLE_SEED = SEED_HIERARCHY.flatMap(g =>
    g.members.map(name => ({ Name: name, Group: g.label, Color: SEED_PERSON_COLORS[name] || '#888' }))
);
let peopleHierarchy, personColors, limaSet;
({ peopleHierarchy, personColors, limaSet } = buildPeopleStructures(PEOPLE_SEED, GROUPS));

// Načte list "People" a prepise live struktury; pri chybe/absenci ponechava seed.
async function refreshPeopleFromSheet() {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['People'];
        if (!sheet) { console.warn('[PEOPLE] List "People" nenalezen - pouzivam seed.'); return; }
        const dataRows = await sheet.getRows();
        const data = dataRows.map(r => ({ Name: r.get('Name'), Group: r.get('Group'), Color: r.get('Color') }));
        if (data.length === 0) { console.warn('[PEOPLE] List "People" je prazdny - pouzivam seed.'); return; }
        const built = buildPeopleStructures(data, GROUPS);
        peopleHierarchy = built.peopleHierarchy;
        personColors    = built.personColors;
        limaSet         = built.limaSet;
        built.warnings.forEach(w => console.warn('[PEOPLE] ' + w));
        console.log('[PEOPLE] Nacteno z listu: ' + data.length + ' lidi.');
    } catch (e) {
        console.error('[PEOPLE] Chyba nacitani, ponechavam soucasna data:', e.message);
    }
}

const PRODUCT_MAPPING_SEED = [
    { name: "Valhalla Cup A",  startCol: 2,  trading: "FIFA",       slots: [{o:0,s:'22:55',e:'06:44'},{o:1,s:'06:55',e:'14:48'},{o:2,s:'14:55',e:'22:47'}] },
    { name: "Valhalla Cup B",  startCol: 6,  trading: "FIFA",       slots: [{o:0,s:'22:57',e:'06:46'},{o:1,s:'06:57',e:'14:50'},{o:2,s:'14:57',e:'22:49'}] },
    { name: "Valhalla Cup C",  startCol: 10, trading: "FIFA",       slots: [{o:0,s:'00:04',e:'08:04'},{o:1,s:'08:04',e:'16:04'},{o:2,s:'16:04',e:'00:04'}] },
    { name: "Valkyrie Cup A",  startCol: 14, trading: "FIFA",       slots: [{o:0,s:'22:40',e:'06:22'},{o:1,s:'06:40',e:'14:32'},{o:2,s:'14:40',e:'22:32'}] },
    { name: "Valkyrie Cup B",  startCol: 18, trading: "FIFA",       slots: [{o:0,s:'22:42',e:'06:24'},{o:1,s:'06:42',e:'14:34'},{o:2,s:'14:42',e:'22:34'}] },
    { name: "Valhalla League", startCol: 22, trading: "NBA",        slots: [{o:0,s:'23:40',e:'07:44'},{o:1,s:'08:00',e:'16:00'},{o:2,s:'16:00',e:'23:40'}] },
    { name: "Yodha League",    startCol: 26, trading: "Cricket",    slots: [{o:0,s:'23:00',e:'07:00'},{o:1,s:'07:00',e:'15:00'},{o:2,s:'15:00',e:'23:00'}] },
    { name: "CS 2 Duels",      startCol: 30, trading: "Duels",      slots: [{o:0,s:'00:00',e:'08:00'},{o:1,s:'08:00',e:'16:00'},{o:2,s:'16:00',e:'00:00'}] },
    { name: "Dota 2 Duels",    startCol: 34, trading: "Duels",      slots: [{o:0,s:'00:01',e:'08:00'},{o:1,s:'08:00',e:'16:00'},{o:2,s:'16:00',e:'00:01'}] },
    { name: "Madden",          startCol: 38, trading: "eTouchdown", slots: [{o:0,s:'23:10',e:'07:10'},{o:1,s:'07:10',e:'15:10'},{o:2,s:'15:10',e:'23:10'}] },
    { name: "Table Tennis",    startCol: 42, trading: "Table Tennis", slots: [{o:0,s:'23:00',e:'07:00'},{o:1,s:'07:00',e:'15:00'},{o:2,s:'15:00',e:'23:00'}] },
    { name: "World of Tanks",  startCol: 46, trading: "Tanks",        slots: [{o:0,s:'23:30',e:'07:30'},{o:1,s:'07:30',e:'15:30'},{o:2,s:'15:30',e:'23:30'}] },
    { name: "eHockey",         startCol: 50, trading: "Hockey",       slots: [{o:0,s:'00:00',e:'08:00'},{o:1,s:'08:00',e:'16:00'},{o:2,s:'16:00',e:'00:00'}] }
];

function convertSheetTime(val) {
    if (!val) return null;
    if (typeof val === 'number' && val >= 0 && val < 1) {
        const totalMinutes = Math.round(val * 24 * 60);
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
    }
    const s = val.toString().trim();
    if (/^\d{1,2}:\d{2}$/.test(s)) return s;
    return s;
}

// Aliasy pro lidi s ruznymi zapisy v Sheets vs peopleHierarchy.
// Klic = jak je zapsano v Sheets / BambooHR; hodnota = kanonicky tvar v peopleHierarchy.
const PERSON_ALIASES = {
    'Sebastian W.': 'Sebastián W.',
    'Robert Š.': 'Robert Šobíšek',
    'Ladislav B.': 'Ladislav Bánský',
    'Przemek': 'Przemyslaw K.',
    'Patrik Ř.': 'Patrik Říčka',
    'Martin J.': 'Martin Jílek',
    'Matěj K.': 'Matěj Kos',
    'Kevin Rojas': 'Kevin R.'
};

// Rozdeli kombinovany zaznam typu "A + B" na pole jmen a aplikuje aliasy.
// Vraci pole kanonickych jmen (typicky 1, ale 2+ kdyz buncka obsahuje "+").
function normalizePersonName(raw) {
    if (!raw) return [];
    return String(raw).split(/\s*\+\s*/).map(part => {
        const t = part.trim();
        return PERSON_ALIASES[t] || t;
    }).filter(n => n.length > 0);
}

async function loadAllShifts(forceSync, opts) {
    opts = opts || {};
    if (isCacheValid() && !forceSync && !opts.refresh) {
        console.log('Cache HIT - pouzivam ulozena data (' + _shiftsCache.length + ' smen)');
        return _shiftsCache;
    }
    console.log('Cache MISS - nacitam z Google Sheets...');
    if (forceSync) _hiddenSheets.clear();
    await doc.loadInfo();

    // BambooHR: pull approved vacations into ManualShifts before we read the sheet
    if (forceSync && BAMBOOHR_API_KEY) {
        try {
            const r = await syncBambooVacations(true);
            console.log('[SYNC] BambooHR result: +' + r.added + ' / -' + r.removed + (r.error ? ' error=' + r.error : ''));
        } catch(e) { console.error('[SYNC] BambooHR sync threw:', e.message); }
    }

    const allShifts = [];
    const overrideKeys = new Set(); // a ManualShift override hides the matching Schedule slot shift (key: Name|Date|Product|Start|End)

    // 1. SYNC Z PLANNERU - cte vsechny listy "Schedule - *"
    const allSheetTitles = Object.keys(doc.sheetsByTitle);
    const scheduleSheets = allSheetTitles.filter(t => t.startsWith('Schedule -') && !_hiddenSheets.has(t));

    console.log('[SYNC] Found schedule sheets:', scheduleSheets);
    console.log('[SYNC] Hidden sheets:', [..._hiddenSheets]);
    // PERF: nacti bunky VSECH listu paralelne (drive sekvencne = hlavni zdroj pomaleho loadingu).
    const _toLoad = scheduleSheets.map(function (t) {
        const sh = doc.sheetsByTitle[t];
        return sh ? sh.loadCells('A1:BG500').catch(function (e) { console.error('Chyba loadCells ' + t + ':', e.message); }) : Promise.resolve();
    });
    const _manualForLoad = doc.sheetsByTitle['ManualShifts'];
    if (_manualForLoad) _toLoad.push(_manualForLoad.loadCells('A1:Z500').catch(function (e) { console.error('Chyba loadCells ManualShifts:', e.message); }));
    await Promise.all(_toLoad);

    for (const sheetTitle of scheduleSheets) {
        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) { console.log('[SYNC] Sheet not found in doc:', sheetTitle); continue; }
        try {
            let sheetShiftCount = 0;
            for (let r = 0; r < Math.min(sheet.rowCount, 500); r++) {
                const dateCell = sheet.getCell(r, 0);
                const rawDate = dateCell.formattedValue || dateCell.value;
                const dateVal = convertCzechDate(rawDate);
                if (!dateVal) continue;
                productMapping.forEach(pm => {
                    pm.slots.forEach(slot => {
                        const col = pm.startCol + slot.o;
                        const cell = sheet.getCell(r, col);
                        const val = cell.value ? cell.value.toString().trim() : '';
                        if (val !== '' && val !== '-') {
                            let shiftDate = dateVal;
                            const startH = parseInt(slot.s.split(':')[0]), endH = parseInt(slot.e.split(':')[0]);
                            if (startH >= 20 && endH < 12) {
                                const d = new Date(dateVal + 'T12:00:00');
                                d.setDate(d.getDate() - 1);
                                shiftDate = d.toISOString().slice(0, 10);
                            }
                            val.split(',').forEach(n => {
                                const rawName = n.trim();
                                normalizePersonName(rawName).forEach(name => {
                                    if (name) { sheetShiftCount++; allShifts.push({
                                        Date: shiftDate, Name: name,
                                        Trading: pm.trading, Product: pm.name,
                                        Start: slot.s, End: slot.e, Note: "",
                                        _sheet: sheetTitle, _row: r, _col: col
                                    }); }
                                });
                            });
                        }
                    });
                });

                // OFF/Vacation kolonky BC-BG (col 54-58) — kazda non-prazdna bunka = "ten den volno"
                for (let offCol = 54; offCol <= 58; offCol++) {
                    const offCell = sheet.getCell(r, offCol);
                    const offVal = offCell.value ? offCell.value.toString().trim() : '';
                    if (offVal === '' || offVal === '-') continue;
                    offVal.split(',').forEach(n => {
                        const rawName = n.trim();
                        normalizePersonName(rawName).forEach(name => {
                            if (!name) return;
                            allShifts.push({
                                Date: dateVal, Name: name,
                                Trading: 'HR', Product: 'Vacation',
                                Start: '00:00', End: '23:59',
                                Note: 'Schedule sheet off-column',
                                _sheet: sheetTitle, _row: r, _col: offCol
                            });
                        });
                    });
                }
            }
            console.log('[SYNC] Sheet "' + sheetTitle + '": loaded ' + sheetShiftCount + ' shifts');
        } catch (sheetErr) {
            console.error('Chyba pri cteni listu ' + sheetTitle + ':', sheetErr.message);
        }
    }

    // 2. MANUAL SHIFTS ze listu ManualShifts
    try {
        const manualSheet = doc.sheetsByTitle['ManualShifts'];
        if (manualSheet) {
            // bunky uz nactene v paralelnim batchi vyse
            let mColDate=-1,mColName=-1,mColTrading=-1,mColProduct=-1,mColStart=-1,mColEnd=-1,mColNote=-1,mColId=-1,mColOverride=-1;
            for (let c = 0; c < 13; c++) {
                const v = manualSheet.getCell(0, c).value?.toString().trim().toLowerCase();
                if (v === 'date')    mColDate    = c;
                if (v === 'name')    mColName    = c;
                if (v === 'trading') mColTrading = c;
                if (v === 'product') mColProduct = c;
                if (v === 'start')   mColStart   = c;
                if (v === 'end')     mColEnd     = c;
                if (v === 'note')    mColNote    = c;
                if (v === 'id')      mColId      = c;
                if (v === 'overridekey') mColOverride = c;
            }
            for (let r = 1; r < Math.min(manualSheet.rowCount, 500); r++) {
                const rawD = mColDate >= 0 ? manualSheet.getCell(r, mColDate).value : null;
                const d = convertCzechDate(rawD) || (rawD ? rawD.toString().trim() : null);
                const nRaw = mColName >= 0 ? manualSheet.getCell(r, mColName).value?.toString().trim() : null;
                if (!d || !nRaw || nRaw === '') continue;
                const normalizedNames = normalizePersonName(nRaw);
                if (normalizedNames.length === 0) continue;
                const ovKey = mColOverride >= 0 ? (manualSheet.getCell(r, mColOverride).value?.toString().trim() || '') : '';
                if (ovKey) overrideKeys.add(ovKey);
                normalizedNames.forEach(nname => {
                allShifts.push({
                    Date:    d,
                    Name:    nname,
                    Trading: mColTrading >= 0 ? manualSheet.getCell(r, mColTrading).value?.toString() || 'Other' : 'Other',
                    Product: mColProduct >= 0 ? manualSheet.getCell(r, mColProduct).value?.toString() || '' : '',
                    Start:   mColStart >= 0 ? convertSheetTime(manualSheet.getCell(r, mColStart).value) || '00:00' : '00:00',
                    End:     mColEnd   >= 0 ? convertSheetTime(manualSheet.getCell(r, mColEnd).value)   || '01:00' : '01:00',
                    Note:    mColNote    >= 0 ? manualSheet.getCell(r, mColNote).value?.toString()    || '' : '',
                    _sheet: 'ManualShifts',
                    _row:   r,
                    _col:   mColName >= 0 ? mColName : 1,
                    _id:    mColId >= 0 ? (manualSheet.getCell(r, mColId).value?.toString().trim() || null) : null,
                    _manual: true
                });
                });
            }
        }
    } catch(e) { console.log('ManualShifts:', e.message); }

    // Deduplikace - klic = Date|Name|Product|Start|End
    // (typicke pripady: BambooHR vacation + Schedule off-column zapsani stejneho dne)
    const beforeDedupe = allShifts.length;
    const seen = new Set();
    const deduped = [];
    for (const s of allShifts) {
        // Override: a ManualShift override replaces the matching Schedule slot shift -> hide the Schedule original
        if (!s._manual && overrideKeys.size) {
            const ok = (s.Name || '') + '|' + (s.Date || '') + '|' + (s.Product || '') + '|' + (s.Start || '') + '|' + (s.End || '');
            if (overrideKeys.has(ok)) continue;
        }
        const key = (s.Date || '') + '|' + (s.Name || '') + '|' + (s.Product || '') + '|' + (s.Start || '') + '|' + (s.End || '');
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
    }
    if (beforeDedupe !== deduped.length) {
        console.log('[DEDUPE] Odstraneno ' + (beforeDedupe - deduped.length) + ' duplikatu (' + beforeDedupe + ' -> ' + deduped.length + ')');
    }
    setCache(deduped);
    console.log('Nacteno z Sheets a ulozeno do cache: ' + deduped.length + ' smen');
    return deduped;
}

// --- CAPABILITIES (kdo muze delat jaky produkt) ---
let _capsCache = null;
let _capsCacheTime = 0;
const CAPS_TTL = 5 * 60 * 1000;

async function loadCapabilities() {
    if (_capsCache && (Date.now() - _capsCacheTime < CAPS_TTL)) return _capsCache;
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Capabilities'];
    if (!sheet) throw new Error('Sheet "Capabilities" nenalezen');
    await sheet.loadCells('A1:Z200');

    const products = [];
    for (let c = 1; c < 26; c++) {
        const h = sheet.getCell(0, c);
        const name = (h.value || h.formattedValue || '').toString().trim();
        if (!name) break;
        products.push({ col: c, name });
    }

    const byPerson = {};
    const byProduct = {};
    products.forEach(p => byProduct[p.name] = []);

    for (let r = 1; r < 200; r++) {
        const nameCell = sheet.getCell(r, 0);
        const name = (nameCell.value || nameCell.formattedValue || '').toString().trim();
        if (!name) continue;
        const canDo = [];
        products.forEach(p => {
            const cell = sheet.getCell(r, p.col);
            const v = (cell.value == null ? '' : cell.value.toString().trim());
            if (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'x') {
                canDo.push(p.name);
                byProduct[p.name].push(name);
            }
        });
        byPerson[name] = canDo;
    }

    // obohat o group + weeklyTarget z peopleHierarchy
    const personMeta = {};
    peopleHierarchy.forEach(g => {
        g.members.forEach(m => {
            personMeta[m] = { group: g.label, weeklyTarget: g.target, color: g.color };
        });
    });

    const result = {
        products: products.map(p => p.name),
        byPerson,
        byProduct,
        personMeta,
        generatedAt: new Date().toISOString()
    };
    _capsCache = result;
    _capsCacheTime = Date.now();
    return result;
}

// Zajisti, ze list "People" existuje a je naplneny (jinak nasype soucasny seed).
async function ensurePeopleSheetSeeded() {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['People'];
    if (!sheet) sheet = await doc.addSheet({ title: 'People', headerValues: ['Name', 'Group', 'Color'] });
    const rows = await sheet.getRows();
    if (rows.length === 0) {
        const seed = [];
        peopleHierarchy.forEach(g => g.members.forEach(nm => seed.push({ Name: nm, Group: g.label, Color: personColors[nm] || '#888' })));
        if (seed.length) await sheet.addRows(seed);
    }
    return sheet;
}

// Zapise/aktualizuje radek osoby v listu "Capabilities" (pozicni matice).
async function writeCapabilityRow(name, selectedProducts) {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['Capabilities'];
    if (!sheet) sheet = await doc.addSheet({ title: 'Capabilities', headerValues: ['Name'].concat(productMapping.map(p => p.name)) });
    await sheet.loadCells('A1:Z200');

    const headerProducts = [];
    let lastCol = 0;
    for (let c = 1; c < 26; c++) {
        const hn = (sheet.getCell(0, c).value || sheet.getCell(0, c).formattedValue || '').toString().trim();
        if (!hn) { lastCol = c - 1; break; }
        headerProducts.push({ col: c, name: hn }); lastCol = c;
    }
    (selectedProducts || []).forEach(p => {
        if (!headerProducts.some(h => h.name === p)) {
            lastCol += 1;
            if (lastCol >= 26) throw new Error('Capabilities: prilis mnoho produktovych sloupcu (max 25)');
            sheet.getCell(0, lastCol).value = p; headerProducts.push({ col: lastCol, name: p });
        }
    });

    let targetRow = -1, firstEmpty = -1;
    for (let r = 1; r < 200; r++) {
        const nm = (sheet.getCell(r, 0).value || '').toString().trim();
        if (nm === name) { targetRow = r; break; }
        if (!nm && firstEmpty === -1) firstEmpty = r;
    }
    if (targetRow === -1) {
        if (firstEmpty === -1) throw new Error('Capabilities: zadny volny radek (>199 zaznamu)');
        targetRow = firstEmpty;
    }

    sheet.getCell(targetRow, 0).value = name;
    computeCapabilityCells(headerProducts, selectedProducts).forEach(({ col, value }) => {
        sheet.getCell(targetRow, col).value = value;
    });
    await sheet.saveUpdatedCells();
}

// Vymaze radek osoby z listu "Capabilities" (vycisti bunky, neposouva radky).
async function removeCapabilityRow(name) {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Capabilities'];
    if (!sheet) return;
    await sheet.loadCells('A1:Z200');
    for (let r = 1; r < 200; r++) {
        const nm = (sheet.getCell(r, 0).value || '').toString().trim();
        if (nm === name) {
            for (let c = 0; c < 26; c++) sheet.getCell(r, c).value = '';
            await sheet.saveUpdatedCells();
            return;
        }
    }
}

// ========================================================================
// SCHEDULE GENERATOR — prompt builder + hard-constraint validator
// Cil: vygenerovat valid month schedule pro 1 produkt nebo cely mesic.
// Nejdriv postavim prompt + validator, az bude ANTHROPIC_API_KEY, volame API.
// ========================================================================

function parseMonthLabel(label) {
    // "June 2026" -> { year: 2026, month: 6, monthName: "June" }
    const parts = label.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const monthMap = {January:1,February:2,March:3,April:4,May:5,June:6,July:7,August:8,September:9,October:10,November:11,December:12};
    const m = monthMap[parts[0]];
    const y = parseInt(parts[1]);
    if (!m || !y) return null;
    return { year: y, month: m, monthName: parts[0] };
}

function getMonthDates(year, month) {
    // Vraci vsechny dny mesice s ISO datem, dayOfWeek a isWeekend
    const dates = [];
    const last = new Date(year, month, 0).getDate();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    for (let d = 1; d <= last; d++) {
        const dt = new Date(Date.UTC(year, month - 1, d));
        const iso = dt.toISOString().slice(0, 10);
        const dow = dt.getUTCDay();
        dates.push({ date: iso, dayName: dayNames[dow], dow, isWeekend: dow === 0 || dow === 6 });
    }
    return dates;
}

function getProductMeta(productName) {
    return productMapping.find(p => p.name === productName) || null;
}

// Coverage profile = ktere sloty + ktere dny ma generator pokrývat.
// Default = 24/7 (vsechny 3 sloty, kazdy den)
// 'weekdays' = pondeli az patek (dow 1-5), 'weekends' = (dow 0 a 6), 'all' = vsechny
const PRODUCT_COVERAGE_SEED = {
    "Table Tennis":   { slots: [0,1,2], days: 'all' },      // 24/7
    "World of Tanks": { slots: [1],     days: 'weekdays' }, // jen ranni Po-Pa
    "eHockey":        { slots: [1,2],   days: 'all' },      // ranni + odpoledni, kazdy den (16/7)
};

// --- Produkty: trading kategorie (barva/ikona) zustavaji v kodu (jako role lidi v 2A) ---
const TRADING_CATEGORIES = [
    { name: "FIFA",         color: "#fbc02d", icon: "&#9917;"   },
    { name: "NBA",          color: "#2196f3", icon: "&#127936;" },
    { name: "Cricket",      color: "#4caf50", icon: "&#127955;" },
    { name: "Duels",        color: "#9c27b0", icon: "&#9876;"   },
    { name: "eTouchdown",   color: "#795548", icon: "&#127944;" },
    { name: "Table Tennis", color: "#00bcd4", icon: "&#127955;" },
    { name: "Tanks",        color: "#607d8b", icon: "&#128299;" },
    { name: "Hockey",       color: "#e91e63", icon: "&#127954;" },
    { name: "Other",        color: "#607d8b", icon: "&#128203;", subs: ["Stand Up", "1on1", "All Hands", "Training", "Interview", "Other Event", "RIP", "Vacation"] }
];

// --- Produkty: live struktury (seed = fallback; pri startu/refreshe prepsane z listu "Products") ---
const PRODUCTS_SEED = PRODUCT_MAPPING_SEED.map(p => ({
    Name: p.name, Trading: p.trading, Color: PRODUCT_COLORS_SEED[p.name] || '',
    StartCol: p.startCol,
    NightStart: p.slots[0].s,     NightEnd: p.slots[0].e,
    MorningStart: p.slots[1].s,   MorningEnd: p.slots[1].e,
    AfternoonStart: p.slots[2].s, AfternoonEnd: p.slots[2].e,
    CoverageSlots: PRODUCT_COVERAGE_SEED[p.name] ? PRODUCT_COVERAGE_SEED[p.name].slots.join(',') : '',
    CoverageDays:  PRODUCT_COVERAGE_SEED[p.name] ? PRODUCT_COVERAGE_SEED[p.name].days : '',
}));

let productMapping, productColors, productCoverage, tradingHierarchy;
({ productMapping, productColors, productCoverage, tradingHierarchy } =
    buildProductStructures(PRODUCTS_SEED, TRADING_CATEGORIES));

// Nacte list "Products" a prepise live struktury; pri chybe/absenci/odmitnuti ponechava seed.
async function refreshProductsFromSheet() {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Products'];
        if (!sheet) { console.warn('[PRODUCTS] List "Products" nenalezen - pouzivam seed.'); return; }
        const rows = (await sheet.getRows()).map(r => ({
            Name: r.get('Name'), Trading: r.get('Trading'), Color: r.get('Color'), StartCol: r.get('StartCol'),
            NightStart: r.get('NightStart'), NightEnd: r.get('NightEnd'),
            MorningStart: r.get('MorningStart'), MorningEnd: r.get('MorningEnd'),
            AfternoonStart: r.get('AfternoonStart'), AfternoonEnd: r.get('AfternoonEnd'),
            CoverageSlots: r.get('CoverageSlots'), CoverageDays: r.get('CoverageDays'),
        }));
        if (rows.length === 0) { console.warn('[PRODUCTS] List "Products" je prazdny - pouzivam seed.'); return; }
        const built = buildProductStructures(rows, TRADING_CATEGORIES);
        if (built.rejected) { console.error('[PRODUCTS] List odmitnut (' + built.rejected + ') - drzim seed.'); return; }
        productMapping   = built.productMapping;
        productColors    = built.productColors;
        productCoverage  = built.productCoverage;
        tradingHierarchy = built.tradingHierarchy;
        built.warnings.forEach(w => console.warn('[PRODUCTS] ' + w));
        console.log('[PRODUCTS] Nacteno z listu: ' + built.productMapping.length + ' produktu.');
    } catch (e) {
        console.error('[PRODUCTS] Chyba nacitani, ponechavam soucasna data:', e.message);
    }
}

function getCoverageProfile(productName) {
    return productCoverage[productName] || { slots: [0,1,2], days: 'all' };
}

function isDateInCoverage(dateObj, coverage) {
    if (coverage.days === 'all') return true;
    if (coverage.days === 'weekdays') return dateObj.dow >= 1 && dateObj.dow <= 5;
    if (coverage.days === 'weekends') return dateObj.dow === 0 || dateObj.dow === 6;
    return true;
}

function buildGeneratorPrompt({ monthLabel, product, capabilities, existingShifts, rules }) {
    const parsed = parseMonthLabel(monthLabel);
    if (!parsed) throw new Error('Invalid month label: ' + monthLabel);
    const dates = getMonthDates(parsed.year, parsed.month);
    const pm = getProductMeta(product);
    if (!pm) throw new Error('Product not found: ' + product);

    // eligible people for this product
    const eligible = (capabilities.byProduct[product] || []).filter(name => capabilities.personMeta[name]);
    const eligibleWithMeta = eligible.map(name => ({
        name,
        group: capabilities.personMeta[name].group,
        weeklyTargetHours: capabilities.personMeta[name].weeklyTarget
    }));

    // existing shifts relevant to this month — EXCLUDE the product we are regenerating
    // and INCLUDE only shifts of eligible people (others are irrelevant for this product)
    const monthPrefix = parsed.year + '-' + String(parsed.month).padStart(2,'0');
    const eligibleSet = new Set(capabilities.byProduct[product] || []);
    const relevantExisting = existingShifts
        .filter(s => s.Date && s.Date.startsWith(monthPrefix))
        .filter(s => s.Product !== product) // regenerujeme TENTO produkt
        .filter(s => eligibleSet.has(s.Name)) // OPTIMALIZACE: jen smeny lidi eligible pro tento produkt
        .map(s => ({
            date: s.Date,
            person: s.Name,
            product: s.Product,
            start: s.Start,
            end: s.End,
            isVacation: s.Product === 'Vacation' || s.Product === 'RIP'
        }));

    const coverage = getCoverageProfile(product);
    const activeSlotSet = new Set(coverage.slots);
    const slotDescriptions = pm.slots.map((s, i) => {
        const kind = i === 0 ? 'night' : (i === 1 ? 'morning' : 'afternoon');
        return { slotIndex: i, kind, start: s.s, end: s.e, active: activeSlotSet.has(i) };
    });

    // Filtrovane datumy (jen ty, kde mame coverage)
    const activeDates = dates.filter(d => isDateInCoverage(d, coverage));
    const totalActiveSlots = activeDates.length * coverage.slots.length;

    const systemPrompt = `You are a shift scheduler for Oddin.gg's esports trading department.

Your job: produce a FRESH monthly schedule for ONE product (specified below). Fill only the slot/day combinations defined by the coverage profile. Assign exactly one person per active slot. Respect all hard constraints. Minimise soft-constraint violations.

COVERAGE PROFILE — read carefully:
- The product specifies which slotIndex values are ACTIVE (e.g. [1] = only morning, [0,1,2] = full 24/7, [1,2] = morning+afternoon = 16/7).
- The product also specifies which days are covered: 'all' (every day), 'weekdays' (Mon–Fri only), 'weekends' (Sat+Sun only).
- ONLY emit shifts for date/slot combinations that match the coverage. Do not emit shifts for inactive slots or out-of-coverage days.
- HARD CONSTRAINTS ARE ABSOLUTE — NEVER violate them, regardless of any other setting. If filling a slot would create ANY hard violation, LEAVE THE SLOT EMPTY. Never trade hard correctness for coverage.
- allowPartialCoverage in payload only affects how you communicate empty slots: when true, empty slots are normal and OK; when false, empty slots are still REQUIRED if needed for hard compliance, but treat them as exceptional and explicitly note WHY in the notes field (e.g. "left 2026-07-15 night empty — only Marek M. eligible but he has morning that day").
- It is ALWAYS better to leave a slot unfilled than to assign someone with a hard conflict. The human scheduler can fix gaps later.

IMPORTANT — about existingShifts:
- existingShifts represents COMMITMENTS THAT ALREADY EXIST: vacations (RIP/Vacation) and shifts on OTHER products for the same people in the same month.
- existingShifts does NOT contain any shifts for the product you are scheduling — that product is empty and YOU must fill every active slot from scratch.
- Never copy a person from existingShifts into your output. Treat existingShifts as a SET OF UNAVAILABILITIES.
- Your task is constructive: pick people from eligiblePeople and assign them, avoiding all conflicts.

HARD CONSTRAINTS (never violated — schedule rejected if any fail):
H1. Only fill slot/day combos defined by the coverage profile. Do not invent slots outside coverage.
H2. The assigned person MUST appear in the eligiblePeople list. Never use a name not in that list.
H3. The person must NOT have an existing Vacation or RIP shift on that date.
H4. A person must NOT work both morning (slot 1) and night (slot 0) on the same calendar date — across existingShifts AND your own output.
H5. A person must NOT work more than 7 consecutive calendar days. Combine existingShifts + your new shifts when counting.
H6. If a person already has a shift on another product on the same date, do NOT schedule them on this product the same date.
H7. A person must NOT work Night (slot 0) on date X AND Morning (slot 1) on date X+1.
  CRITICAL TIMING: Night slot has 'date = X' but the actual shift runs from evening of day X (e.g. 22:55) THROUGH the night INTO morning of day X+1 (e.g. ends 06:44 on day X+1). Then morning slot on day X+1 starts at 06:55. The handover gap is only 11 minutes.
  WHEN ASSIGNING ANY MORNING slot on date Y, ALWAYS first check: does this person have a night (slot 0) on date Y-1 (previous day) in either existingShifts or your own output? If yes — pick someone else.
H8. A person must NOT work Afternoon (slot 2) AND Night (slot 0) on the same calendar date X — these slots have only ~5-15 minutes between them due to shift handover.
H9. Members of groups "Team Leaders", "Title Experts", "Quality Assurance", and "Master Scheduler" MUST NEVER be assigned Night shifts (slotIndex 0). Their group label is available in the eligiblePeople list. Only Traders (Europe/Lima) and "Head of Trading - eSims" can be assigned night shifts.

ASSIGNMENT METHODOLOGY (follow this process for EACH slot you fill):
1. Process dates chronologically (earliest first), within each date process slots in order: night (0), morning (1), afternoon (2).
2. For the current date + slot, list ALL eligiblePeople as initial candidates.
3. For EACH candidate, RULE OUT if any of:
   a. Has Vacation or RIP on that date (existingShifts) — H3.
   b. Already has ANY shift on the same date (existingShifts OR your own output) — H4/H6/H8.
   c. If assigning MORNING (slot 1) on day Y: has a Night (slot 0) on day Y-1 in existingShifts OR your own output — H7 (only 11 min between them!).
   d. If assigning NIGHT (slot 0) on day X: has an Afternoon (slot 2) on day X same person — H8.
   e. Would reach >7 consecutive days — H5.
   f. Member of TL/TE/QA/Scheduler being assigned a night (slot 0) — H9 NEVER allowed.
4. From the surviving candidates, prefer the one whose current hour count is FURTHEST below their weekly target (= even distribution).
5. If NO candidate survives, LEAVE THE SLOT EMPTY and note it in the notes field. Hard constraints are absolute — never violate them just to fill a slot.

SELF-CHECK BEFORE SUBMITTING:
For every person who appears in your output, mentally list their shifts in chronological order across this month (existing + your new). For each consecutive pair, confirm:
- Not morning(X) + night(X) same date → H4
- Not afternoon(X) + night(X) same date → H8
- Not night(X) + morning(X+1) consecutive days → H7
- Not 8+ days in a row → H5
If you find ANY violation, FIX IT by reassigning before submitting.

SOFT CONSTRAINTS (minimise, but acceptable in limited amount):
S1. Each person should land within ±8 hours of their weekly target over the month (pro-rated).
S2. Avoid afternoon→next-morning transitions (min 7h rest between consecutive shifts).
S3. Weekend shifts distributed fairly — no single person should work more than 70% of weekend slots this month.
S4. Lima and Europe groups should share weekend slots roughly equally.

OUTPUT FORMAT (strict — JSON only, no prose before/after):
{
  "shifts": [
    {"date": "YYYY-MM-DD", "slotIndex": 0, "person": "Full Name"},
    ...
  ],
  "notes": "Short summary of tradeoffs and any soft violations"
}

The exact number of shifts to produce equals "totalSlotsToFill" in the payload (= activeDatesCount × number of activeSlots). If allowPartialCoverage is true and you cannot fill every active slot without breaking hard constraints or pushing people way over target hours, leave that slot out and mention it in "notes".`;

    const userPayload = {
        task: 'Generate monthly schedule for one product (respect coverage profile)',
        monthLabel,
        year: parsed.year,
        month: parsed.month,
        product,
        coverageProfile: {
            activeSlots: coverage.slots,
            days: coverage.days,
            note: coverage.days === 'weekdays' ? 'Only Monday-Friday (dow 1-5)'
                : coverage.days === 'weekends' ? 'Only Saturday-Sunday (dow 0 or 6)'
                : 'Every day of the month'
        },
        slots: slotDescriptions,
        daysInMonth: dates.length,
        activeDatesCount: activeDates.length,
        totalSlotsToFill: totalActiveSlots,
        allowPartialCoverage: rules?.allowPartialCoverage === true,
        dates,
        eligiblePeople: eligibleWithMeta,
        existingShifts: relevantExisting,
        customRules: rules || {}
    };

    return {
        system: systemPrompt,
        user: 'Here is the structured input. Return only the JSON schedule.\n\n' + JSON.stringify(userPayload, null, 2)
    };
}

// --- VALIDATOR ---

function validateGeneratedSchedule(generated, { product, capabilities, existingShifts, monthLabel, allowPartialCoverage }) {
    const errors = [];
    const warnings = [];
    const parsed = parseMonthLabel(monthLabel);
    if (!parsed) { errors.push({ code: 'BAD_MONTH', msg: 'Invalid month label' }); return { errors, warnings }; }
    const dates = getMonthDates(parsed.year, parsed.month);
    const dateMap = new Map(dates.map(d => [d.date, d]));
    const eligible = new Set((capabilities.byProduct[product] || []));
    const coverage = getCoverageProfile(product);
    const activeSlotSet = new Set(coverage.slots);

    const shifts = Array.isArray(generated.shifts) ? generated.shifts : [];

    // FILTER: existingShifts na current product odebrat. Regenerujeme TENTO produkt,
    // takze stara data v ManualShifts/Schedule by se ZAMUMLALA s novym vystupem od Claude.
    // Vacations zustavaji (plati napric vsemi produkty).
    const filteredExisting = existingShifts.filter(ex => {
        if (ex.Product === 'Vacation' || ex.Product === 'RIP') return true;
        return ex.Product !== product;
    });
    existingShifts = filteredExisting;


    // H1: coverage — only required for ACTIVE slot/day combos
    const seen = {};
    dates.forEach(d => seen[d.date] = { 0: null, 1: null, 2: null });
    shifts.forEach((s, idx) => {
        const dateMeta = dateMap.get(s.date);
        if (!dateMeta) {
            errors.push({ code: 'DATE_OUTSIDE_MONTH', msg: 'Shift #' + idx + ' has date ' + s.date + ' not in ' + monthLabel });
            return;
        }
        if (![0,1,2].includes(s.slotIndex)) {
            errors.push({ code: 'BAD_SLOT', msg: 'Shift #' + idx + ' slotIndex=' + s.slotIndex });
            return;
        }
        if (!activeSlotSet.has(s.slotIndex)) {
            errors.push({ code: 'SLOT_OUT_OF_COVERAGE', msg: 'Shift on ' + s.date + ' slot ' + s.slotIndex + ' — slot not in coverage profile' });
            return;
        }
        if (!isDateInCoverage(dateMeta, coverage)) {
            errors.push({ code: 'DATE_OUT_OF_COVERAGE', msg: 'Shift on ' + s.date + ' (' + dateMeta.dayName + ') — outside coverage days (' + coverage.days + ')' });
            return;
        }
        if (seen[s.date][s.slotIndex] !== null) {
            errors.push({ code: 'DUPLICATE_SLOT', msg: 'Duplicate assignment for ' + s.date + ' slot ' + s.slotIndex });
        }
        seen[s.date][s.slotIndex] = s.person;
    });
    dates.forEach(d => {
        if (!isDateInCoverage(d, coverage)) return;
        coverage.slots.forEach(sl => {
            if (seen[d.date][sl] === null) {
                const code = 'UNCOVERED_SLOT';
                const msg = 'Missing person for ' + d.date + ' slot ' + sl;
                if (allowPartialCoverage) warnings.push({ code, msg });
                else errors.push({ code, msg });
            }
        });
    });

    // H2: eligibility
    shifts.forEach((s, idx) => {
        if (!eligible.has(s.person)) {
            errors.push({ code: 'NOT_ELIGIBLE', msg: s.person + ' cannot work ' + product + ' (shift #' + idx + ')' });
        }
    });

    // H9: no nights for TL/TE/QA/Scheduler
    const noNightGroups = new Set(['Team Leaders', 'Title Experts', 'Quality Assurance', 'Master Scheduler']);
    shifts.forEach((s, idx) => {
        if (s.slotIndex !== 0) return;
        const meta = capabilities.personMeta[s.person];
        if (meta && noNightGroups.has(meta.group)) {
            errors.push({ code: 'NO_NIGHTS_FOR_GROUP', msg: s.person + ' (' + meta.group + ') was assigned night on ' + s.date + ' — H9 forbids nights for this group' });
        }
    });

    // H3: vacation clash
    const monthPrefix = parsed.year + '-' + String(parsed.month).padStart(2,'0');
    const vacByPersonDate = {};
    existingShifts.forEach(ex => {
        if (!ex.Date || !ex.Date.startsWith(monthPrefix)) return;
        if (ex.Product === 'Vacation' || ex.Product === 'RIP') {
            const key = ex.Name + '|' + ex.Date;
            vacByPersonDate[key] = ex.Product;
        }
    });
    shifts.forEach(s => {
        const key = s.person + '|' + s.date;
        if (vacByPersonDate[key]) {
            errors.push({ code: 'VACATION_CLASH', msg: s.person + ' is on ' + vacByPersonDate[key] + ' on ' + s.date });
        }
    });

    // H4: morning + night same day (across all products)
    // Build per-person-per-date slot map from BOTH existingShifts and generated
    const personDateSlots = {}; // key = name|date, val = Set of {night, morning, afternoon}
    function addSlot(name, date, kind) {
        const key = name + '|' + date;
        if (!personDateSlots[key]) personDateSlots[key] = new Set();
        personDateSlots[key].add(kind);
    }
    function classifyExistingSlot(start) {
        // crude: start < 10 -> morning, 10-18 -> afternoon, else night
        if (!start || !/^\d{1,2}:/.test(start)) return null;
        const h = parseInt(start.split(':')[0]);
        if (h >= 20 || h < 6) return 'night';
        if (h >= 6 && h < 13) return 'morning';
        return 'afternoon';
    }
    existingShifts.forEach(ex => {
        if (!ex.Date || !ex.Date.startsWith(monthPrefix)) return;
        if (ex.Product === 'Vacation' || ex.Product === 'RIP') return;
        const kind = classifyExistingSlot(ex.Start);
        if (kind) addSlot(ex.Name, ex.Date, kind);
    });
    shifts.forEach(s => {
        const kind = s.slotIndex === 0 ? 'night' : (s.slotIndex === 1 ? 'morning' : 'afternoon');
        addSlot(s.person, s.date, kind);
    });
    Object.entries(personDateSlots).forEach(([key, set]) => {
        if (set.has('morning') && set.has('night')) {
            const [name, date] = key.split('|');
            errors.push({ code: 'MORNING_NIGHT_SAME_DAY', msg: name + ' has both morning and night on ' + date });
        }
        // H8: afternoon + night same day (~5-15 min handover gap)
        if (set.has('afternoon') && set.has('night')) {
            const [name, date] = key.split('|');
            errors.push({ code: 'AFTERNOON_NIGHT_SAME_DAY', msg: name + ' has both afternoon and night on ' + date + ' (handover gap is only ~5-15 min)' });
        }
    });

    // H7: night on day X + morning on day X+1 (~10-15 min handover gap)
    Object.keys(personDateSlots).forEach(key => {
        const set = personDateSlots[key];
        if (!set.has('night')) return;
        const [name, date] = key.split('|');
        const next = new Date(date + 'T12:00:00Z');
        next.setUTCDate(next.getUTCDate() + 1);
        const nextDateStr = next.toISOString().slice(0, 10);
        const nextKey = name + '|' + nextDateStr;
        const nextSet = personDateSlots[nextKey];
        if (nextSet && nextSet.has('morning')) {
            errors.push({ code: 'NIGHT_THEN_MORNING_NEXT_DAY', msg: name + ' has night on ' + date + ' followed by morning on ' + nextDateStr + ' (handover gap is only ~10-15 min)' });
        }
    });

    // H5: max 7 consecutive days
    const personDays = {};
    Object.keys(personDateSlots).forEach(key => {
        const [name, date] = key.split('|');
        if (!personDays[name]) personDays[name] = new Set();
        personDays[name].add(date);
    });
    Object.entries(personDays).forEach(([name, daySet]) => {
        const sorted = [...daySet].sort();
        let run = 1;
        for (let i = 1; i < sorted.length; i++) {
            const prev = new Date(sorted[i-1] + 'T12:00:00Z');
            const cur = new Date(sorted[i] + 'T12:00:00Z');
            const diffDays = Math.round((cur - prev) / 86400000);
            if (diffDays === 1) {
                run++;
                if (run > 7) {
                    errors.push({ code: 'CONSECUTIVE_DAYS', msg: name + ' works ' + run + ' consecutive days ending ' + sorted[i] });
                }
            } else {
                run = 1;
            }
        }
    });

    // S1: weekly hour target (soft) — approximate with 8h per shift
    const personHours = {};
    shifts.forEach(s => {
        personHours[s.person] = (personHours[s.person] || 0) + 8;
    });
    // Plus existing shifts for this person in the same month
    existingShifts.forEach(ex => {
        if (!ex.Date || !ex.Date.startsWith(monthPrefix)) return;
        if (ex.Product === 'Vacation' || ex.Product === 'RIP') return;
        personHours[ex.Name] = (personHours[ex.Name] || 0) + 8;
    });
    const weeksInMonth = dates.length / 7;
    Object.entries(personHours).forEach(([name, hrs]) => {
        const meta = capabilities.personMeta[name];
        if (!meta) return;
        const monthTarget = meta.weeklyTarget * weeksInMonth;
        const delta = hrs - monthTarget;
        if (Math.abs(delta) > monthTarget * 0.2) {
            warnings.push({ code: 'HOURS_OFF_TARGET', msg: name + ' has ' + hrs + 'h vs target ' + monthTarget.toFixed(0) + 'h (delta ' + (delta > 0 ? '+' : '') + delta.toFixed(0) + 'h)' });
        }
    });

    // S3: weekend distribution
    const weekendSlots = dates.filter(d => d.isWeekend).length * 3;
    const personWeekendCount = {};
    shifts.forEach(s => {
        const d = dates.find(dd => dd.date === s.date);
        if (d && d.isWeekend) personWeekendCount[s.person] = (personWeekendCount[s.person] || 0) + 1;
    });
    Object.entries(personWeekendCount).forEach(([name, cnt]) => {
        const pct = cnt / weekendSlots;
        if (pct > 0.7) {
            warnings.push({ code: 'WEEKEND_HOGGING', msg: name + ' covers ' + (pct*100).toFixed(0) + '% of weekend slots' });
        }
    });

    return { errors, warnings };
}

// --- POMOCNÉ FUNKCE ---

function toISOLocal(date) {
    const z = date.getTimezoneOffset() * 60000;
    return (new Date(date - z)).toISOString().slice(0, 10);
}

function convertCzechDate(dateVal) {
    if (dateVal === null || dateVal === undefined || dateVal === '') return null;
    if (typeof dateVal === 'number') {
        if (dateVal < 1000) return null;
        const epoch = new Date(Date.UTC(1899, 11, 30));
        epoch.setUTCDate(epoch.getUTCDate() + Math.floor(dateVal));
        return epoch.toISOString().slice(0, 10);
    }
    if (dateVal instanceof Date) return toISOLocal(dateVal);
    const s = dateVal.toString().trim();
    if (!s || s === '-') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4,6}$/.test(s)) {
        const serial = parseInt(s);
        if (serial > 1000) {
            const epoch = new Date(Date.UTC(1899, 11, 30));
            epoch.setUTCDate(epoch.getUTCDate() + serial);
            return epoch.toISOString().slice(0, 10);
        }
    }
    const match = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})$/);
    if (match) {
        const d = match[1].padStart(2, '0');
        const m = match[2].padStart(2, '0');
        const y = match[3].length === 2 ? '20' + match[3] : match[3];
        return y + '-' + m + '-' + d;
    }
    return null;
}

// Soft·Glass: pastelizace barvy (smichani s bilou) pro svetle pilulky s tmavym textem (modulova uroven -> scope pro vsechny pohledy)
function pastel(hex) {
    if (!hex || hex.charAt(0) !== '#' || (hex.length !== 7 && hex.length !== 4)) return hex;
    var r, g, b;
    if (hex.length === 4) { r = parseInt(hex.charAt(1) + hex.charAt(1), 16); g = parseInt(hex.charAt(2) + hex.charAt(2), 16); b = parseInt(hex.charAt(3) + hex.charAt(3), 16); }
    else { r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16); }
    if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
    var m = 0.10;
    return 'rgb(' + Math.round(r + (255 - r) * m) + ',' + Math.round(g + (255 - g) * m) + ',' + Math.round(b + (255 - b) * m) + ')';
}
function timeToPercent(timeStr) {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return ((hours * 60 + minutes) / (24 * 60)) * 100;
}

function calculateDuration(start, end) {
    if(!start || !end) return 0;
    const [sH, sM] = start.split(':').map(Number);
    const [eH, eM] = end.split(':').map(Number);
    let diff = (eH * 60 + eM) - (sH * 60 + sM);
    if (diff < 0) diff += 1440;
    return (diff / 60);
}

function checkOverlap(shift, allShifts) {
    const sStart = timeToPercent(shift.get('Start'));
    const sEnd = timeToPercent(shift.get('End'));
    const sDate = shift.get('Date');
    const sProd = shift.get('Product')?.trim();
    if(!sProd) return false;
    return allShifts.some(other => {
        if (shift === other) return false;
        if (other.get('Date') !== sDate || other.get('Product')?.trim() !== sProd) return false;
        const oStart = timeToPercent(other.get('Start'));
        const oEnd = timeToPercent(other.get('End'));
        return (sStart < oEnd && oStart < sEnd);
    });
}

// --- API ---

app.post('/login', loginLimiter, async (req, res) => {
    const emailInput = req.body.email.toLowerCase().trim();
    const passwordInput = req.body.password.trim();
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['uzivatele'];
        await sheet.loadCells('A1:Z500');

        // Najdi sloupce podle hlavicky v radku 1
        let colJmeno=-1, colEmail=-1, colHeslo=-1, colRole=-1, colLocation=-1, colSlackId=-1;
        for (let c = 0; c < 15; c++) {
            const v = sheet.getCell(0, c).value?.toString().trim().toLowerCase();
            if (v === 'jmeno')    colJmeno    = c;
            if (v === 'email')    colEmail    = c;
            if (v === 'heslo')    colHeslo    = c;
            if (v === 'role')     colRole     = c;
            if (v === 'location') colLocation = c;
            if (v === 'slack_id') colSlackId  = c;
        }

        let foundUser = null;
        let foundRow = -1, foundLegacy = false;
        for (let r = 1; r < sheet.rowCount && r < 200; r++) {
            const email = colEmail >= 0 ? sheet.getCell(r, colEmail).value?.toString().toLowerCase().trim() : '';
            const heslo = colHeslo >= 0 ? sheet.getCell(r, colHeslo).value?.toString().trim() : '';
            if (email === emailInput) {
                const v = verifyPassword(passwordInput, heslo);
                if (v.ok) {
                    foundRow = r; foundLegacy = v.legacy;
                    foundUser = {
                        jmeno:    colJmeno    >= 0 ? sheet.getCell(r, colJmeno).value?.toString().trim()    : '',
                        email:    email,
                        role:     colRole     >= 0 ? sheet.getCell(r, colRole).value?.toString().trim()     : 'User',
                        location: colLocation >= 0 ? sheet.getCell(r, colLocation).value?.toString().trim() : '',
                        slack_id: colSlackId  >= 0 ? sheet.getCell(r, colSlackId).value?.toString().trim()  : ''
                    };
                }
                break;
            }
        }

        // Líná migrace: legacy plaintext heslo přepiš na scrypt hash
        if (foundUser && foundLegacy && foundRow >= 0 && colHeslo >= 0) {
            try {
                sheet.getCell(foundRow, colHeslo).value = hashPassword(passwordInput);
                await sheet.saveUpdatedCells();
            } catch (e) { console.error('Hash upgrade chyba:', e.message); }
        }

        if (foundUser) {
            req.session.user = foundUser;
            loginLimiter.reset(req); // uspesne prihlaseni vynuluje pocitadlo pokusu

            // Remember me — HMAC token cookie na 30 dni
            if (req.body.remember === 'on') {
                const thirtyDays = 30 * 24 * 60 * 60 * 1000;
                req.session.cookie.maxAge = thirtyDays;
                const token = makeRememberToken(foundUser);
                res.append('Set-Cookie', 'remember_token=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30*24*60*60));
            }

            // AuditLog - zapis prihlaseni
            try {
                const auditSheet = doc.sheetsByTitle['AuditLog'];
                if (auditSheet) {
                    await auditSheet.addRow({
                        Timestamp: new Date().toISOString(),
                        Jmeno:     foundUser.jmeno,
                        Email:     foundUser.email,
                        Role:      foundUser.role,
                        Location:  foundUser.location,
                        Action:    'LOGIN'
                    });
                }
            } catch (auditErr) { console.error('AuditLog chyba:', auditErr.message); }

            if (req.headers.accept && req.headers.accept.includes('application/json')) {
                res.json({ success: true });
            } else {
                res.redirect('/dashboard');
            }
        } else {
            if (req.headers.accept && req.headers.accept.includes('application/json')) {
                res.json({ success: false });
            } else {
                res.redirect('/?error=1');
            }
        }
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// BOD 4: LOGOUT
app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'remember_token=; Path=/; HttpOnly; Max-Age=0');
    req.session.destroy(() => { res.redirect('/'); });
});

// --- CHANGE PASSWORD ---

// GET - zobraz stranku pro zmenu hesla
app.get('/change-password', (req, res) => {
    if (!req.user) return res.redirect('/');
    const error   = req.query.error   || '';
    const success = req.query.success || '';
    const initials = req.user.jmeno ? req.user.jmeno.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) : '?';
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Change Password — DRACHIR.GG</title>
    <meta name="csrf-token" content="${req.session.csrf}">
    <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;600;700&family=Russo+One&display=swap" rel="stylesheet">
    <style>
        *{box-sizing:border-box;margin:0;padding:0;}
        :root{--gold:#fbc02d;--gold-dim:rgba(251,192,45,0.15);--gold-glow:rgba(251,192,45,0.5);--bg:#0a0b0f;--card:#0d0e14;--border:#1e2030;--text:#e0e0e0;--muted:rgba(255,255,255,0.4);}
        body{font-family:'Chakra Petch',sans-serif;background:var(--bg);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;position:relative;overflow:hidden;}
        body::before{content:'';position:fixed;inset:-30px;background:linear-gradient(180deg,rgba(10,11,15,0.25) 0%,rgba(10,11,15,0.55) 100%),url('/images/drachir-bg.jpg') center 30%/cover;z-index:-1;filter:saturate(1.2) brightness(0.9);}
        body::after{content:'';position:fixed;inset:0;box-shadow:inset 0 0 200px 60px rgba(0,0,0,0.6);z-index:0;pointer-events:none;}
        .card{position:relative;z-index:1;width:100%;max-width:480px;background:rgba(13,14,20,0.88);border:1px solid var(--border);border-radius:20px;overflow:hidden;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 32px 80px rgba(0,0,0,0.7),0 0 0 1px rgba(251,192,45,0.06);animation:cardIn 0.5s cubic-bezier(0.16,1,0.3,1);}
        @keyframes cardIn{0%{opacity:0;transform:translateY(20px) scale(0.97);}100%{opacity:1;transform:none;}}
        .card-top-line{height:2px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:0.6;}
        .card-header{padding:32px 36px 24px;text-align:center;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(251,192,45,0.04) 0%,transparent 60%);}
        .logo{font-family:'Russo One',sans-serif;color:var(--gold);font-size:1.9rem;letter-spacing:5px;text-transform:uppercase;text-shadow:0 0 20px var(--gold-glow),0 0 40px rgba(251,192,45,0.2);}
        .subtitle{font-size:0.68rem;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:4px;margin-top:6px;font-weight:400;}
        .card-body{padding:28px 36px 32px;}
        .user-row{display:flex;align-items:center;gap:14px;padding:14px 18px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:12px;margin-bottom:24px;}
        .avatar{width:42px;height:42px;border-radius:50%;background:#0a0b0f;border:2px solid rgba(251,192,45,0.3);display:flex;align-items:center;justify-content:center;font-family:'Russo One';color:var(--gold);font-size:1rem;flex-shrink:0;box-shadow:0 0 16px rgba(251,192,45,0.1);}
        .user-name{font-weight:700;color:#fff;font-size:0.92rem;letter-spacing:0.3px;}
        .user-email{font-size:0.68rem;color:rgba(255,255,255,0.3);margin-top:2px;}
        .alert{padding:12px 16px;border-radius:10px;font-size:0.78rem;margin-bottom:16px;display:flex;align-items:center;gap:10px;letter-spacing:0.3px;}
        .alert-error{background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.25);color:#ff6b6b;}
        .alert-success{background:rgba(76,175,80,0.08);border:1px solid rgba(76,175,80,0.25);color:#69c56e;}
        .alert svg{flex-shrink:0;}
        .field{margin-bottom:18px;}
        .field label{display:block;font-size:0.62rem;color:rgba(251,192,45,0.6);text-transform:uppercase;letter-spacing:1.2px;font-weight:700;margin-bottom:7px;}
        .input-wrap{position:relative;}
        .input-wrap input{width:100%;padding:12px 44px 12px 14px;background:rgba(0,0,0,0.4);border:1px solid var(--border);border-radius:10px;color:#fff;font-family:'Chakra Petch';font-size:0.88rem;transition:all 0.2s;color-scheme:dark;}
        .input-wrap input:focus{outline:none;border-color:rgba(251,192,45,0.5);background:rgba(0,0,0,0.6);box-shadow:0 0 0 3px rgba(251,192,45,0.08),0 0 20px rgba(251,192,45,0.05);}
        .input-wrap input:hover:not(:focus){border-color:#2a2d3a;}
        .toggle-pw{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(255,255,255,0.25);cursor:pointer;padding:4px;font-size:0.75rem;font-family:'Chakra Petch';transition:color 0.2s;}
        .toggle-pw:hover{color:var(--gold);}
        .divider{height:1px;background:var(--border);margin:6px 0 22px;}
        .rules{font-size:0.66rem;color:rgba(255,255,255,0.25);line-height:1.9;margin-top:-10px;margin-bottom:22px;}
        .rules span{display:block;padding-left:12px;position:relative;}
        .rules span::before{content:'·';position:absolute;left:0;color:rgba(251,192,45,0.4);}
        .btn{width:100%;padding:15px;background:linear-gradient(135deg,#fbc02d 0%,#f9a825 100%);color:#000;border:none;border-radius:10px;font-weight:700;font-family:'Russo One';font-size:0.95rem;text-transform:uppercase;letter-spacing:2px;cursor:pointer;transition:all 0.2s;box-shadow:0 4px 20px rgba(251,192,45,0.2);position:relative;overflow:hidden;}
        .btn::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);transition:left 0.5s;}
        .btn:hover{background:linear-gradient(135deg,#ffe082 0%,#fbc02d 100%);box-shadow:0 6px 28px rgba(251,192,45,0.35);transform:translateY(-1px);}
        .btn:hover::before{left:100%;}
        .btn:active{transform:translateY(0);}
        .back-link{display:block;text-align:center;margin-top:18px;color:rgba(255,255,255,0.2);font-size:0.72rem;text-decoration:none;letter-spacing:1px;transition:color 0.2s;}
        .back-link:hover{color:var(--gold);}
        input::placeholder{color:rgba(255,255,255,0.2);}
    </style>
</head>
<body>
<div class="card">
    <div class="card-top-line"></div>
    <div class="card-header">
        <div class="logo">DRACHIR.GG</div>
        <div class="subtitle">Change Password</div>
    </div>
    <div class="card-body">
        <div class="user-row">
            <div class="avatar">${initials}</div>
            <div>
                <div class="user-name">${req.user.jmeno}</div>
                <div class="user-email">${req.user.email}</div>
            </div>
        </div>

        ${error === 'wrong'   ? '<div class="alert alert-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Current password is incorrect.</div>' : ''}
        ${error === 'nomatch' ? '<div class="alert alert-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>New passwords do not match.</div>' : ''}
        ${error === 'short'   ? '<div class="alert alert-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Password must be at least 6 characters.</div>' : ''}
        ${error === 'same'    ? '<div class="alert alert-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>New password must differ from current.</div>' : ''}
        ${error === 'badchars' ? '<div class="alert alert-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Password contains invalid characters (backtick or \${).</div>' : ''}
        ${success ? '<div class="alert alert-success"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>Password changed successfully!</div>' : ''}

        <form action="/change-password" method="POST" id="pwdForm">
            <input type="hidden" name="_csrf" value="${req.session.csrf}">
            <div class="field">
                <label>Current Password</label>
                <div class="input-wrap">
                    <input type="password" name="currentPassword" id="f1" placeholder="Enter current password" required autocomplete="current-password">
                    <button type="button" class="toggle-pw" onclick="togglePw('f1',this)">Show</button>
                </div>
            </div>
            <div class="divider"></div>
            <div class="field">
                <label>New Password</label>
                <div class="input-wrap">
                    <input type="password" name="newPassword" id="f2" placeholder="Enter new password" required autocomplete="new-password">
                    <button type="button" class="toggle-pw" onclick="togglePw('f2',this)">Show</button>
                </div>
            </div>
            <div class="field">
                <label>Confirm New Password</label>
                <div class="input-wrap">
                    <input type="password" name="confirmPassword" id="f3" placeholder="Repeat new password" required autocomplete="new-password">
                    <button type="button" class="toggle-pw" onclick="togglePw('f3',this)">Show</button>
                </div>
            </div>
            <div class="rules">
                <span>Minimum 6 characters</span>
                <span>Must differ from current password</span>
            </div>
            <button type="submit" class="btn">Change Password</button>
        </form>
        <a href="/dashboard" class="back-link">&#8592; Back to Dashboard</a>
    </div>
</div>
<script>
function togglePw(id,btn){const i=document.getElementById(id);i.type=i.type==='password'?'text':'password';btn.textContent=i.type==='password'?'Show':'Hide';}
</script>
</body>
</html>`);
});

// POST - zpracuj zmenu hesla
app.post('/change-password', async (req, res) => {
    if (!req.user) return res.redirect('/');
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const vErr = validateNoTemplateChars(newPassword);
    if (vErr) return res.redirect('/change-password?error=badchars');
    const userEmail = req.user.email;

    // Validace
    if (newPassword.length < 6)               return res.redirect('/change-password?error=short');
    if (newPassword !== confirmPassword)       return res.redirect('/change-password?error=nomatch');
    if (newPassword === currentPassword)       return res.redirect('/change-password?error=same');

    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['uzivatele'];
        await sheet.loadCells('A1:Z500');

        // Najdi sloupce
        let colEmail=-1, colHeslo=-1;
        for (let c = 0; c < 10; c++) {
            const v = sheet.getCell(0, c).value?.toString().trim().toLowerCase();
            if (v === 'email') colEmail = c;
            if (v === 'heslo') colHeslo = c;
        }

        // Najdi radek uzivatele a over stare heslo
        let userRow = -1;
        for (let r = 1; r < sheet.rowCount && r < 200; r++) {
            const email = colEmail >= 0 ? sheet.getCell(r, colEmail).value?.toString().toLowerCase().trim() : '';
            const heslo = colHeslo >= 0 ? sheet.getCell(r, colHeslo).value?.toString().trim() : '';
            if (email === userEmail) {
                const v = verifyPassword(currentPassword.trim(), heslo);
                if (!v.ok) return res.redirect('/change-password?error=wrong');
                userRow = r;
                break;
            }
        }

        if (userRow < 0) return res.redirect('/change-password?error=wrong');

        // Zapis nove heslo (hashovane)
        sheet.getCell(userRow, colHeslo).value = hashPassword(newPassword.trim());
        await sheet.saveUpdatedCells();

        // AuditLog
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet) await auditSheet.addRow({
                Timestamp: new Date().toISOString(),
                Jmeno:    req.user.jmeno,
                Email:    req.user.email,
                Role:     req.user.role,
                Location: req.user.location || '',
                Action:   'CHANGE_PASSWORD'
            });
        } catch(e) {}

        res.redirect('/change-password?success=1');
    } catch(e) { res.status(500).send('Error: ' + e.message); }
});


// BOD 3: CSV EXPORT směn
app.get('/export-csv', async (req, res) => {
    if (!req.user) return res.redirect('/');

    // Kdo může exportovat: Admin, David Winkler, Ondřej Merxbauer, Team Leaders
    const allowedNames  = ['David Winkler', 'Ondřej Merxbauer'];
    const allowedRoles  = ['Admin'];
    const allowedGroups = ['Team Leaders'];

    // Zjisti skupinu uzivatele
    const userName = req.user.jmeno;
    const userRole = req.user.role;

    // Zkontroluj hierarchii v req - musime ji znat
    const tlMembers = ["Lukáš Novotný", "Filip Sklenička", "Jindřich Lacina", "David Trocino", "David Lamač", "Tomáš Komenda", "Dominik Chvátal", "Marcelo Goto"];
    const canExport = allowedNames.includes(userName) || allowedRoles.includes(userRole) || tlMembers.includes(userName);
    if (!canExport) return res.status(403).send('Access denied');

    try {
        await doc.loadInfo();
        const allSheetTitles = Object.keys(doc.sheetsByTitle);
        const scheduleSheets = allSheetTitles.filter(t => t.startsWith('Schedule -'));

        const rows = [];
        rows.push(['Date','Name','Trading','Product','Start','End','Note','Source']);

        for (const title of scheduleSheets) {
            const sheet = doc.sheetsByTitle[title];
            await sheet.loadCells('A1:BG500');
            // productMapping: pouzij modulovou konstantu definovanou nahore (zadna lokalni kopie)
            for (let r = 0; r < Math.min(sheet.rowCount, 500); r++) {
                const dateCell = sheet.getCell(r, 0);
                const rawDate = dateCell.formattedValue || dateCell.value;
                let dateVal = null;
                if (typeof rawDate === 'number' && rawDate > 1000) {
                    const ep = new Date(Date.UTC(1899,11,30)); ep.setUTCDate(ep.getUTCDate()+Math.floor(rawDate));
                    dateVal = ep.toISOString().slice(0,10);
                } else if (rawDate) {
                    const ds = rawDate.toString().trim();
                    if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
                        dateVal = ds;
                    } else if (/^\d{4,6}$/.test(ds) && parseInt(ds) > 1000) {
                        const ep = new Date(Date.UTC(1899,11,30)); ep.setUTCDate(ep.getUTCDate()+parseInt(ds));
                        dateVal = ep.toISOString().slice(0,10);
                    } else {
                        const m = ds.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})$/);
                        if (m) dateVal = (m[3].length===2?'20'+m[3]:m[3])+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
                    }
                }
                if (!dateVal) continue;
                productMapping.forEach(pm => {
                    pm.slots.forEach(slot => {
                        const cell = sheet.getCell(r, pm.startCol + slot.o);
                        const val = cell.value ? cell.value.toString().trim() : '';
                        if (val && val !== '-') {
                            let csvDate = dateVal;
                            const sH = parseInt(slot.s.split(':')[0]), eH = parseInt(slot.e.split(':')[0]);
                            if (sH >= 20 && eH < 12) {
                                const dd = new Date(dateVal + 'T12:00:00');
                                dd.setDate(dd.getDate() - 1);
                                csvDate = dd.toISOString().slice(0, 10);
                            }
                            val.split(',').forEach(n => {
                                const name = n.trim();
                                if (name) rows.push([csvDate, name, pm.trading, pm.name, slot.s, slot.e, '', title]);
                            });
                        }
                    });
                });
            }
        }

        // Pridej ManualShifts
        const manualSheet = doc.sheetsByTitle['ManualShifts'];
        if (manualSheet) {
            const manualRows = await manualSheet.getRows();
            manualRows.forEach(r => {
                if (r.get('Date') && r.get('Name')) {
                    rows.push([r.get('Date'), r.get('Name'), r.get('Trading')||'', r.get('Product')||'', r.get('Start')||'', r.get('End')||'', r.get('Note')||'', 'ManualShifts']);
                }
            });
        }

        // Filtruj podle osoby pokud je zadana
        const filterName = req.query.name ? req.query.name.trim() : '';
        const exportRows = filterName
            ? [rows[0], ...rows.slice(1).filter(r => r[1] === filterName)]
            : rows;

        // Sestav CSV
        const csv = exportRows.map(r => r.map(v => '"' + (v||'').toString().replace(/"/g,'""') + '"').join(',')).join('\n');
        const month = new Date().toISOString().slice(0,7);
        const fileSuffix = filterName ? '-' + filterName.replace(/[^a-zA-Z0-9]/g, '_') : '';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="drachir-shifts-' + month + fileSuffix + '.csv"');
        res.send('\uFEFF' + csv); // BOM pro Excel
    } catch(e) { res.status(500).send('Error: ' + e.message); }
});


// API - historie konkretni smeny (Created by + posledni 2 edity)
app.get('/api/shift-history', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    const { name, date, product } = req.query;
    if (!name || !date || !product) return res.json({ created: null, edits: [] });
    try {
        await doc.loadInfo();
        const auditSheet = doc.sheetsByTitle['AuditLog'];
        if (!auditSheet) return res.json({ created: null, edits: [] });
        const rows = await auditSheet.getRows();
        const key = (name + '|' + product + '|' + date).toLowerCase();

        let created = null;
        const edits = [];

        rows.forEach(r => {
            const action = (r.get('Action') || '').toLowerCase();
            const ts = r.get('Timestamp') || '';
            const by = r.get('Jmeno') || '';

            if (action.startsWith('add_shift|') && action === 'add_shift|' + key) {
                created = { by, at: ts };
            } else if (action.startsWith('edit_shift|') && action === 'edit_shift|' + key) {
                edits.push({ by, at: ts });
            }
        });

        // Vrat jen posledni 2 edity
        const lastEdits = edits.slice(-2);
        res.json({ created, edits: lastEdits });
    } catch(e) { res.json({ created: null, edits: [] }); }
});

// Admin: prohlížečka audit logu
app.get('/admin/audit-log', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).send('Admin only');
    const qPerson = (req.query.person || '').toLowerCase().trim();
    const qAction = (req.query.action || '').trim();
    const days    = Math.max(1, Math.min(3650, parseInt(req.query.days) || 90));
    const page    = Math.max(1, parseInt(req.query.page) || 1);
    const PER     = 200;
    const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['AuditLog'];
        const all = sheet ? await sheet.getRows() : [];
        let items = all.map(r => ({
            ts:     r.get('Timestamp') || '',
            jmeno:  r.get('Jmeno') || '',
            action: r.get('Action') || (r.get('Event') || ''),
            detail: r.get('Detail') || ''
        }));
        items = items.filter(it => { const d = new Date(it.ts); return isNaN(d) ? true : d >= since; });
        if (qPerson) items = items.filter(it => it.jmeno.toLowerCase().includes(qPerson));
        if (qAction) items = items.filter(it => (it.action || '').toUpperCase().startsWith(qAction.toUpperCase()));
        items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
        const total = items.length;
        const pages = Math.max(1, Math.ceil(total / PER));
        const slice = items.slice((page - 1) * PER, page * PER);

        const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const rowsHtml = slice.map(it =>
            '<tr><td>' + esc(it.ts) + '</td><td>' + esc(it.jmeno) + '</td><td>' + esc(it.action) + '</td><td>' + esc(it.detail) + '</td></tr>'
        ).join('');

        res.send('<!doctype html><html><head><meta charset="utf-8"><title>Audit log</title>'
            + '<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:20px;}'
            + 'table{border-collapse:collapse;width:100%;font-size:0.85rem;}th,td{border:1px solid #333;padding:6px 10px;text-align:left;}'
            + 'th{background:#1c1c1c;position:sticky;top:0;}tr:nth-child(even){background:#181818;}'
            + 'a{color:#6cf;}form{margin-bottom:16px;}input,select{padding:6px;margin-right:8px;background:#1c1c1c;color:#eee;border:1px solid #333;border-radius:4px;}</style>'
            + '</head><body>'
            + '<h2>Audit log <span style="font-size:0.8rem;color:#888;">(' + total + ' records, last ' + days + ' days)</span></h2>'
            + '<p><a href="/dashboard">&larr; back to dashboard</a></p>'
            + '<form method="GET" action="/admin/audit-log">'
            + 'Person: <input name="person" value="' + esc(qPerson) + '" placeholder="name">'
            + 'Action: <input name="action" value="' + esc(qAction) + '" placeholder="ADD_SHIFT, LOGIN...">'
            + 'Days back: <input name="days" type="number" value="' + days + '" style="width:80px">'
            + '<button type="submit">Filter</button></form>'
            + '<table><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>'
            + rowsHtml + '</tbody></table>'
            + '<p style="margin-top:12px;">Page ' + page + '/' + pages + ' '
            + (page > 1 ? '<a href="?person=' + encodeURIComponent(qPerson) + '&action=' + encodeURIComponent(qAction) + '&days=' + days + '&page=' + (page-1) + '">&larr; newer</a> ' : '')
            + (page < pages ? '<a href="?person=' + encodeURIComponent(qPerson) + '&action=' + encodeURIComponent(qAction) + '&days=' + days + '&page=' + (page+1) + '">older &rarr;</a>' : '')
            + '</p></body></html>');
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// API - seznam dostupnych Schedule listu
app.get('/api/schedule-sheets', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json([]);
    try {
        await doc.loadInfo();
        const monthOrder = {January:1,February:2,March:3,April:4,May:5,June:6,July:7,August:8,September:9,October:10,November:11,December:12};
        const sheets = Object.keys(doc.sheetsByTitle)
            .filter(t => t.startsWith('Schedule -'))
            .sort((a, b) => {
                const ma = a.match(/Schedule - (\w+) (\d+)/);
                const mb = b.match(/Schedule - (\w+) (\d+)/);
                if (!ma || !mb) return a.localeCompare(b);
                const yearDiff = parseInt(ma[2]) - parseInt(mb[2]);
                return yearDiff !== 0 ? yearDiff : (monthOrder[ma[1]] || 0) - (monthOrder[mb[1]] || 0);
            });
        res.json(sheets);
    } catch(e) { res.json([]); }
});

// --- CLAUDE API CALLER ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL_DEFAULT = 'claude-opus-4-7';

function callClaude({ system, userMessage, model, maxTokens, tools, toolChoice }) {
    return new Promise((resolve, reject) => {
        if (!ANTHROPIC_API_KEY) return reject(new Error('ANTHROPIC_API_KEY not set on server'));
        const https = require('https');
        const messages = [{ role: 'user', content: userMessage }];
        const payload = {
            model: model || ANTHROPIC_MODEL_DEFAULT,
            max_tokens: maxTokens || 16000,
            system,
            messages
        };
        if (Array.isArray(tools) && tools.length) payload.tools = tools;
        if (toolChoice) payload.tool_choice = toolChoice;
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error('Claude HTTP ' + res.statusCode + ': ' + data.slice(0,500)));
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch(e) { reject(new Error('Claude JSON parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function extractJsonFromText(text) {
    // Claude sometimes wraps JSON in ```json ... ``` or adds prose. Extract first {...} block.
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenced) return JSON.parse(fenced[1]);
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('No JSON object found in response');
}

// Generate schedule for one product × one month (admin-only)
// POST body: { month: "June 2026", product: "Valhalla Cup A", model?: "claude-sonnet-4-6" }
app.post('/api/generate-schedule', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    const { month: monthLabel, product, model, allowPartialCoverage, accumulatedShifts } = req.body || {};
    if (!monthLabel || !product) return res.status(400).json({ error: 'Missing month/product in body' });

    try {
        const caps = await loadCapabilities();
        const allShifts = await loadAllShifts(false);
        if (!caps.byProduct[product]) return res.status(400).json({ error: 'Unknown product: ' + product });
        if ((caps.byProduct[product] || []).length === 0) return res.status(400).json({ error: 'No eligible people for ' + product });

        const apc = allowPartialCoverage === true || allowPartialCoverage === 'true';
        // Combine persistent existing shifts with shifts accumulated during this batch run
        const accumExtras = Array.isArray(accumulatedShifts) ? accumulatedShifts : [];
        const combinedExisting = allShifts.concat(accumExtras);
        const prompt = buildGeneratorPrompt({ monthLabel, product, capabilities: caps, existingShifts: combinedExisting, rules: { allowPartialCoverage: apc } });

        // Structured-output via tool use — guarantees schema-valid JSON, no parsing fragility
        const submitTool = {
            name: 'submit_schedule',
            description: 'Submit the generated schedule. Call this exactly once with the complete schedule.',
            input_schema: {
                type: 'object',
                properties: {
                    shifts: {
                        type: 'array',
                        description: 'One entry per filled slot. Only include active slot/day combos from the coverage profile.',
                        items: {
                            type: 'object',
                            properties: {
                                date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
                                slotIndex: { type: 'integer', enum: [0,1,2], description: '0=night, 1=morning, 2=afternoon' },
                                person: { type: 'string', description: 'Full name exactly as in eligiblePeople' }
                            },
                            required: ['date', 'slotIndex', 'person']
                        }
                    },
                    notes: { type: 'string', description: 'Short summary of tradeoffs and soft violations' }
                },
                required: ['shifts']
            }
        };

        const t0 = Date.now();
        const claudeResp = await callClaude({
            system: prompt.system,
            userMessage: prompt.user,
            model,
            maxTokens: 32000,
            tools: [submitTool],
            toolChoice: { type: 'tool', name: 'submit_schedule' }
        });
        const elapsed = Date.now() - t0;

        const toolBlock = (claudeResp.content || []).find(c => c.type === 'tool_use' && c.name === 'submit_schedule');
        if (!toolBlock) {
            const textBlock = (claudeResp.content || []).find(c => c.type === 'text');
            return res.status(502).json({
                error: 'No submit_schedule tool call in response',
                stopReason: claudeResp.stop_reason,
                rawText: textBlock?.text?.slice(0,2000) || '',
                contentTypes: (claudeResp.content || []).map(c => c.type)
            });
        }
        let generated = toolBlock.input;

        let validation = validateGeneratedSchedule(generated, { product, capabilities: caps, existingShifts: combinedExisting, monthLabel, allowPartialCoverage: apc });
        const usage = { input_tokens: claudeResp.usage?.input_tokens || 0, output_tokens: claudeResp.usage?.output_tokens || 0 };
        const initialErrorCount = validation.errors.length;
        let repairAttempted = false;
        let repairUsage = null;

        // REPAIR LOOP: pokud sou hard violations, zavolat Claude podruhe s opravnym promptem
        if (validation.errors.length > 0) {
            repairAttempted = true;
            const errorList = validation.errors.map(e => '- ' + e.msg).join('\n');
            const prevShiftsJSON = JSON.stringify(generated.shifts, null, 2);
            const repairUserMessage =
                'Your previously generated schedule contains ' + validation.errors.length + ' HARD constraint violations. ' +
                'Regenerate the FULL schedule fixing ALL listed violations. Leave slots empty if needed (allowPartialCoverage is acceptable).\n\n' +
                'YOUR PREVIOUS OUTPUT:\n' + prevShiftsJSON + '\n\n' +
                'VIOLATIONS FROM VALIDATOR:\n' + errorList + '\n\n' +
                'CRITICAL REMINDERS:\n' +
                '- Night (slot 0) on date X runs from ~22:XX of day X THROUGH the night TO ~06:XX of day X+1. Morning (slot 1) on day X+1 starts ~06:55. The gap is only ~11 minutes. SAME PERSON CANNOT have night(X) AND morning(X+1).\n' +
                '- Afternoon (slot 2) ends ~22:XX. Night (slot 0) starts ~22:XX SAME date. SAME PERSON CANNOT have both on same date.\n' +
                '- Morning (slot 1) ends ~14:XX. Cannot pair with night(slot 0) same date — 8h gap but H4 forbids it.\n' +
                '- TL/TE/QA/Scheduler never get nights (H9).\n' +
                '- Cross-product H6: same person same date forbidden across products.\n\n' +
                'Use the submit_schedule tool. Fix EVERY listed violation. Keep all the valid assignments from your previous output.';

            try {
                const tRepair = Date.now();
                const repairResp = await callClaude({
                    system: prompt.system,
                    userMessage: repairUserMessage,
                    model,
                    maxTokens: 32000,
                    tools: [submitTool],
                    toolChoice: { type: 'tool', name: 'submit_schedule' }
                });
                const repairElapsed = Date.now() - tRepair;
                const repairTool = (repairResp.content || []).find(c => c.type === 'tool_use' && c.name === 'submit_schedule');
                if (repairTool) {
                    const repairedGenerated = repairTool.input;
                    const repairedValidation = validateGeneratedSchedule(repairedGenerated, { product, capabilities: caps, existingShifts: combinedExisting, monthLabel, allowPartialCoverage: apc });
                    // Pouze pouz repair vysledek pokud opravdu zmensil pocet errors
                    if (repairedValidation.errors.length < validation.errors.length) {
                        generated = repairedGenerated;
                        validation = repairedValidation;
                    }
                    repairUsage = { input_tokens: repairResp.usage?.input_tokens || 0, output_tokens: repairResp.usage?.output_tokens || 0, elapsedMs: repairElapsed };
                    usage.input_tokens += repairUsage.input_tokens;
                    usage.output_tokens += repairUsage.output_tokens;
                }
            } catch (repairErr) {
                console.error('[REPAIR] error:', repairErr.message);
            }
        }

        // Enriched format ready to be passed back as accumulatedShifts for the next product
        const pm = getProductMeta(product);
        const enrichedShifts = (generated.shifts || []).map(s => {
            const slot = pm && pm.slots[s.slotIndex];
            return {
                Date: s.date,
                Name: s.person,
                Product: product,
                Start: slot ? slot.s : '',
                End: slot ? slot.e : ''
            };
        });

        res.json({
            ok: validation.errors.length === 0,
            monthLabel,
            product,
            modelUsed: claudeResp.model,
            elapsedMs: elapsed,
            usage,
            repairAttempted,
            repairUsage,
            initialErrorCount,
            shiftCount: Array.isArray(generated.shifts) ? generated.shifts.length : 0,
            generatorNotes: generated.notes || '',
            validation,
            shifts: generated.shifts || [],
            enrichedShifts
        });
    } catch(e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// Generator preview (admin-only) — postavi prompt bez volani Claude, vraci payload k inspekci
// Usage: GET /api/generate-preview?month=June%202026&product=Valhalla%20Cup%20A
app.get('/api/generate-preview', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const monthLabel = req.query.month;
    const product = req.query.product;
    if (!monthLabel || !product) return res.status(400).json({ error: 'Missing ?month= and/or ?product=' });
    try {
        const caps = await loadCapabilities();
        const allShifts = await loadAllShifts(false);
        const prompt = buildGeneratorPrompt({ monthLabel, product, capabilities: caps, existingShifts: allShifts, rules: {} });
        const parsed = parseMonthLabel(monthLabel);
        const monthPrefix = parsed.year + '-' + String(parsed.month).padStart(2,'0');
        const monthShifts = allShifts.filter(s => s.Date && s.Date.startsWith(monthPrefix));
        const vacations = monthShifts.filter(s => s.Product === 'Vacation' || s.Product === 'RIP');
        const vacationSummary = {};
        vacations.forEach(v => {
            vacationSummary[v.Name] = vacationSummary[v.Name] || { count: 0, dates: [] };
            vacationSummary[v.Name].count++;
            vacationSummary[v.Name].dates.push(v.Date + ' (' + v.Product + ')');
        });
        res.json({
            monthLabel,
            product,
            eligibleCount: (caps.byProduct[product] || []).length,
            promptSystemLength: prompt.system.length,
            promptUserLength: prompt.user.length,
            vacationsThisMonth: {
                totalDays: vacations.length,
                peopleOnVacation: Object.keys(vacationSummary).length,
                bySummary: vacationSummary
            },
            existingShiftsInMonth: monthShifts.length,
            promptSystem: prompt.system,
            promptUserPreview: prompt.user.slice(0, 3000) + (prompt.user.length > 3000 ? '\n... [truncated]' : ''),
            fullPromptUserTailPreview: prompt.user.length > 3000 ? prompt.user.slice(-2000) : null
        });
    } catch(e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// Capabilities debug endpoint (admin-only) — vraci parsovany Capabilities sheet
app.get('/api/capabilities', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const caps = await loadCapabilities();
        const summary = {};
        caps.products.forEach(p => summary[p] = caps.byProduct[p].length);
        res.json({
            products: caps.products,
            peoplePerProduct: summary,
            totalPeople: Object.keys(caps.byPerson).length,
            byProduct: caps.byProduct,
            byPerson: caps.byPerson,
            personMeta: caps.personMeta,
            generatedAt: caps.generatedAt
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// === Admin: sprava lidi (Faze 3) ===
app.get('/api/admin/people', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const caps = await loadCapabilities();
        const people = [];
        peopleHierarchy.forEach(g => g.members.forEach(nm => people.push({
            name: nm, group: g.label, color: personColors[nm] || '#888', products: caps.byPerson[nm] || []
        })));
        res.json({ people, groups: GROUPS.map(g => g.label), allProducts: productMapping.map(p => p.name) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/people', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const { name, group, color, products } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const vErr = validateNoTemplateChars(name, group, color, ...(Array.isArray(products) ? products : []));
    if (vErr) return res.status(400).json({ error: vErr });
    const existingNames = peopleHierarchy.flatMap(g => g.members);
    const err = validatePersonInput({ name, group, color }, { groups: GROUPS.map(g => g.label), existingNames, mode: 'add' });
    if (err) return res.status(400).json({ error: err });
    if (color && !/^#[0-9a-fA-F]{6}$/.test((color || '').trim())) return res.status(400).json({ error: 'Invalid color (#rrggbb expected)' });
    try {
        const sheet = await ensurePeopleSheetSeeded();
        await sheet.addRow({ Name: name.trim(), Group: group, Color: (color || '').trim() || '#888' });
        await writeCapabilityRow(name.trim(), Array.isArray(products) ? products : []);
        _capsCache = null; _capsCacheTime = 0;
        await refreshPeopleFromSheet();
        try { const a = doc.sheetsByTitle['AuditLog']; if (a) await a.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location || '', Action: 'ADD_PERSON|' + name }); } catch (_) {}
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/people/update', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const { name, group, color, products } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const vErr = validateNoTemplateChars(name, group, color, ...(Array.isArray(products) ? products : []));
    if (vErr) return res.status(400).json({ error: vErr });
    const existingNames = peopleHierarchy.flatMap(g => g.members);
    const err = validatePersonInput({ name, group, color }, { groups: GROUPS.map(g => g.label), existingNames, mode: 'update' });
    if (err) return res.status(400).json({ error: err });
    if (color && !/^#[0-9a-fA-F]{6}$/.test((color || '').trim())) return res.status(400).json({ error: 'Invalid color (#rrggbb expected)' });
    try {
        const sheet = await ensurePeopleSheetSeeded();
        const rows = await sheet.getRows();
        const target = rows.find(r => (r.get('Name') || '').toString().trim() === name.trim());
        if (!target) return res.status(404).json({ error: 'Not found' });
        target.set('Group', group);
        target.set('Color', (color || '').trim() || '#888');
        await target.save();
        await writeCapabilityRow(name.trim(), Array.isArray(products) ? products : []);
        _capsCache = null; _capsCacheTime = 0;
        await refreshPeopleFromSheet();
        try { const a = doc.sheetsByTitle['AuditLog']; if (a) await a.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location || '', Action: 'EDIT_PERSON|' + name }); } catch (_) {}
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/people/remove', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const vErr = validateNoTemplateChars(name);
    if (vErr) return res.status(400).json({ error: vErr });
    try {
        const sheet = await ensurePeopleSheetSeeded();
        const rows = await sheet.getRows();
        const target = rows.find(r => (r.get('Name') || '').toString().trim() === (name || '').trim());
        if (target) await target.delete();
        await removeCapabilityRow((name || '').trim());
        _capsCache = null; _capsCacheTime = 0;
        await refreshPeopleFromSheet();
        try { const a = doc.sheetsByTitle['AuditLog']; if (a) await a.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location || '', Action: 'REMOVE_PERSON|' + name }); } catch (_) {}
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// BambooHR manual sync trigger (admin-only)
app.post('/api/bamboo-sync', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const r = await syncBambooVacations(true);
        invalidateCache();
        res.json({ success: true, ...r });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEBUG endpoint
app.get('/debug-schedule', async (req, res) => {
    if (!req.user) return res.status(401).send('Login first');
    try {
        await doc.loadInfo();
        const allTitles = Object.keys(doc.sheetsByTitle);
        const schedSheets = allTitles.filter(t => t.startsWith('Schedule -'));
        let out = '<style>table{border-collapse:collapse;font-size:11px;}td{border:1px solid #ccc;padding:3px;}</style>';
        out += '<h2>Sheets: ' + JSON.stringify(allTitles) + '</h2>';

        for (const title of schedSheets) {
            const sheet = doc.sheetsByTitle[title];
            await sheet.loadCells('A1:E20');
            out += '<h3>' + title + '</h3><table>';
            out += '<tr><th>row</th><th>A value</th><th>A type</th><th>A formatted</th><th>converted</th><th>B</th><th>C</th><th>D</th><th>E</th></tr>';
            for (let r = 0; r < 15; r++) {
                const cellA = sheet.getCell(r, 0);
                const rawVal = cellA.formattedValue || cellA.value;
                // inline conversion test
                let converted = 'null';
                if (typeof cellA.value === 'number' && cellA.value > 1000) {
                    const ep = new Date(Date.UTC(1899, 11, 30));
                    ep.setUTCDate(ep.getUTCDate() + Math.floor(cellA.value));
                    converted = ep.toISOString().slice(0,10);
                } else if (cellA.formattedValue) {
                    converted = 'FMT:' + cellA.formattedValue;
                }
                out += '<tr>'
                    + '<td>' + r + '</td>'
                    + '<td>' + JSON.stringify(cellA.value) + '</td>'
                    + '<td>' + typeof cellA.value + '</td>'
                    + '<td>' + JSON.stringify(cellA.formattedValue) + '</td>'
                    + '<td><b>' + converted + '</b></td>'
                    + '<td>' + (sheet.getCell(r,1).value||'') + '</td>'
                    + '<td>' + (sheet.getCell(r,2).value||'') + '</td>'
                    + '<td>' + (sheet.getCell(r,3).value||'') + '</td>'
                    + '<td>' + (sheet.getCell(r,4).value||'') + '</td>'
                    + '</tr>';
            }
            out += '</table>';
        }
        res.send(out);
    } catch(e) { res.status(500).send('Error: ' + e.message + '<br>' + e.stack); }
});

// add-shift - ulozi do listu "ManualShifts" v Google Sheets
app.post('/add-shift', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    const vErr = validateNoTemplateChars(req.body.name, req.body.product, req.body.trading, req.body.note, req.body.date);
    if (vErr) return res.status(400).json({ error: vErr });
    try {
        await doc.loadInfo();
        // Pokud list ManualShifts does not exist, vytvor ho
        let sheet = doc.sheetsByTitle['ManualShifts'];
        if (!sheet) {
            sheet = await doc.addSheet({ title: 'ManualShifts', headerValues: ['Date','Name','Trading','Product','Start','End','Note','AddedBy','Id'] });
        }
        await sheet.addRow({
            Date:    req.body.date,
            Name:    req.body.name,
            Trading: req.body.trading,
            Product: req.body.product,
            Start:   req.body.start,
            End:     req.body.end,
            Note:    req.body.note || '',
            AddedBy: req.user.jmeno,
            Id:      crypto.randomUUID()
        });
        // AuditLog
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet) await auditSheet.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location||'', Action: 'ADD_SHIFT|' + req.body.name + '|' + req.body.product + '|' + req.body.date });
        } catch(e) {}
        invalidateCache();
        sendSlackMessage(':heavy_plus_sign: *Shift added* by ' + req.user.jmeno + ': ' + req.body.name + ' - ' + req.body.product + ' on ' + req.body.date + ' (' + req.body.start + '-' + req.body.end + (limaSet.has(req.body.name) ? ' — Lima: ' + shiftLimaTime(req.body.start) + '-' + shiftLimaTime(req.body.end) : '') + ')');
        try { if (req.body.name && req.body.name !== req.user.jmeno) addNotification(req.body.name, req.user.jmeno + ' added you a shift: ' + req.body.product + ' on ' + req.body.date + ' (' + req.body.start + '-' + req.body.end + ')', '/dashboard'); } catch (e) {}
        notifyShiftChange(req.user.jmeno, req.body.name, 'added', req.body.product + ' on ' + req.body.date + ' (' + req.body.start + '-' + req.body.end + ')', req.body.start, req.body.end);
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

// custom-colors - sdilene barvy pro vsechny uzivatele
app.get('/api/custom-colors', async (req, res) => {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['CustomColors'];
        if (!sheet) return res.json({});
        const rows = await sheet.getRows();
        const colors = {};
        rows.forEach(r => {
            const name = r.get('Name'), color = r.get('Color');
            if (name && color) colors[name] = color;
        });
        res.json(colors);
    } catch(e) { res.status(500).send(e.message); }
});

app.post('/api/set-color', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    try {
        const { name, color } = req.body;
        if (!name) return res.status(400).send('Missing name');
        await doc.loadInfo();
        let sheet = doc.sheetsByTitle['CustomColors'];
        if (!sheet) {
            sheet = await doc.addSheet({ title: 'CustomColors', headerValues: ['Name','Color'] });
        }
        const rows = await sheet.getRows();
        const existing = rows.find(r => r.get('Name') === name);
        if (color) {
            if (existing) { existing.set('Color', color); await existing.save(); }
            else { await sheet.addRow({ Name: name, Color: color }); }
        } else {
            if (existing) await existing.delete();
        }
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

app.post('/api/reset-colors', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['CustomColors'];
        if (sheet) {
            const rows = await sheet.getRows();
            for (let i = rows.length - 1; i >= 0; i--) await rows[i].delete();
        }
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

app.post('/update-shift', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    const { originalName, originalDate, originalStart, name, date, start, end, product, trading, note, id, overrideKey } = req.body;
    const vErr = validateNoTemplateChars(name, product, trading, note, date);
    if (vErr) return res.status(400).json({ error: vErr });
    let createdId = null;
    try {
        await doc.loadInfo();

        // Najdi a aktualizuj radek v ManualShifts
        let manualSheet = doc.sheetsByTitle['ManualShifts'];
        if (!manualSheet && overrideKey) {
            manualSheet = await doc.addSheet({ title: 'ManualShifts', headerValues: ['Date','Name','Trading','Product','Start','End','Note','AddedBy','Id','OverrideKey'] });
        }
        if (manualSheet) {
            const rows = await manualSheet.getRows();
            // Najdi shodny radek podle originalName + originalDate + originalStart
            let target = null;
            if (id) target = rows.find(r => (r.get('Id') || '') === id);
            if (!target) target = rows.find(r => {
                const rDate = convertCzechDate(r.get('Date') || '');
                return r.get('Name') === originalName
                    && rDate === originalDate
                    && r.get('Start') === originalStart;
            });
            if (target) {
                target.set('Name',    name    || originalName);
                target.set('Date',    date    || originalDate);
                target.set('Start',   start);
                target.set('End',     end);
                target.set('Product', product);
                target.set('Trading', trading);
                target.set('Note',    note || '');
                await target.save();
            } else if (overrideKey) {
                // Editing a Schedule (non-manual) shift: create a ManualShift override that hides the Schedule slot
                if (!manualSheet.headerValues.includes('OverrideKey')) { await manualSheet.setHeaderRow(manualSheet.headerValues.concat(['OverrideKey'])); }
                createdId = crypto.randomUUID();
                await manualSheet.addRow({ Date: date || originalDate, Name: name || originalName, Trading: trading || 'Other', Product: product || '', Start: start, End: end, Note: note || '', AddedBy: req.user.jmeno, Id: createdId, OverrideKey: overrideKey }, { raw: true });
            } else {
                invalidateCache();
                return res.json({ success: true, found: false });
            }
        } else {
            invalidateCache();
            return res.json({ success: true, found: false });
        }

        // AuditLog
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet && name && product && date) {
                await auditSheet.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location||'', Action: 'EDIT_SHIFT|' + name + '|' + product + '|' + date });
            }
        } catch(e) {}

        invalidateCache();
        sendSlackMessage(':pencil2: *Shift edited* by ' + req.user.jmeno + ': ' + (name || originalName) + ' - ' + (product || '') + ' on ' + (date || originalDate) + ' (' + start + '-' + end + (limaSet.has(name || originalName) ? ' — Lima: ' + shiftLimaTime(start) + '-' + shiftLimaTime(end) : '') + ')');
        notifyShiftChange(req.user.jmeno, name || originalName, createdId ? 'rescheduled' : 'edited', (product || '') + ' on ' + (date || originalDate) + ' (' + start + '-' + end + ')', start, end);
        res.json({ success: true, found: true, created: !!createdId, id: createdId || id || null });
    } catch(e) { res.status(500).send(e.message); }
});

// DELETE SHIFT - pro ManualShifts maze radek ze Sheetu, pro Schedule listy jen z cache
app.post('/delete-shift', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    const { sheetTitle, row, col, name, id } = req.body;
    try {
        await doc.loadInfo();

        if (sheetTitle === 'ManualShifts') {
            // ManualShifts: skutecne smaz radek z Google Sheets
            const manualSheet = doc.sheetsByTitle['ManualShifts'];
            if (manualSheet) {
                const rows = await manualSheet.getRows();
                let target = null;
                if (id) target = rows.find(r => (r.get('Id') || '') === id);
                if (!target) {
                    // fallback: stara shoda podle indexu radku (radky bez Id)
                    const rowIdx = parseInt(row);
                    target = rows.find((_r, i) => (i + 1) === rowIdx);
                }
                if (target) {
                    await target.delete();
                }
            }
            invalidateCache();
        } else {
            // Schedule listy: smaz jen z cache (nemenime zdroj)
            if (_shiftsCache) {
                _shiftsCache = _shiftsCache.filter(s =>
                    !(s.Name === name && s._sheet === sheetTitle && s._row === parseInt(row))
                );
            }
        }

        // AuditLog
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet) {
                await auditSheet.addRow({
                    Timestamp: new Date().toISOString(),
                    Jmeno:    req.user.jmeno,
                    Email:    req.user.email,
                    Role:     req.user.role,
                    Location: req.user.location || '',
                    Action:   'DELETE_SHIFT|' + name + '|' + sheetTitle
                });
            }
        } catch(e) {}

        sendSlackMessage(':x: *Shift deleted* by ' + req.user.jmeno + ': ' + name + ' from ' + sheetTitle);
        notifyShiftChange(req.user.jmeno, name, 'deleted', name + ' from ' + sheetTitle);
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

// Hromadne mazani smen (Faze 5). Maze jen ManualShifts (podle Id); Schedule smeny nejsou editovatelne.
app.post('/api/bulk-delete', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });
    if (items.length > 200) return res.status(400).json({ error: 'Too many items (max 200)' });
    const vErr = validateNoTemplateChars.apply(null, items.map(function (it) { return (it && it.name) || ''; }));
    if (vErr) return res.status(400).json({ error: vErr });
    const part = partitionSelection(items);
    const ids = new Set(dedupeIds(part.manual.map(function (m) { return m.id; })));
    let deleted = 0;
    try {
        await doc.loadInfo();
        if (ids.size > 0) {
            const sheet = doc.sheetsByTitle['ManualShifts'];
            if (sheet) {
                const rows = await sheet.getRows();
                const targets = rows.filter(function (r) { return ids.has((r.get('Id') || '').toString()); });
                // mazat odzadu — delete posouva indexy ostatnich radku
                for (let i = targets.length - 1; i >= 0; i--) { await targets[i].delete(); deleted++; }
            }
        }
        invalidateCache();
        try {
            const a = doc.sheetsByTitle['AuditLog'];
            if (a) await a.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location || '', Action: 'BULK_DELETE_SHIFT|count=' + deleted });
        } catch (_) {}
        try { sendSlackMessage(':wastebasket: *Bulk delete* by ' + req.user.jmeno + ': ' + deleted + ' shifts'); } catch (_) {}
        res.json({ success: true, deleted: deleted, scheduleSkipped: part.scheduleOnly.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Zadosti o vymenu smen (swap requests) ======
const SWAP_HEADERS = ['Id','CreatedAt','RequesterName','RequesterEmail','ShiftDate','ShiftProduct','ShiftTrading','ShiftStart','ShiftEnd','ShiftSheet','ShiftRow','ShiftCol','ShiftMsId','Note','Status','ClaimedBy','ClaimedByEmail','UpdatedAt','ResolvedBy'];
function isManager(u) { return !!u && u.role === 'Admin'; }
async function getSwapSheet() {
    let sheet = doc.sheetsByTitle['SwapRequests'];
    if (!sheet) sheet = await doc.addSheet({ title: 'SwapRequests', headerValues: SWAP_HEADERS });
    return sheet;
}
function swapRowToObj(r) { const o = {}; SWAP_HEADERS.forEach(h => { o[h] = r.get(h); }); return o; }
async function readSwaps(sheet) { return (await sheet.getRows()).map(swapRowToObj); }
async function findSwapRow(sheet, id) { return (await sheet.getRows()).find(x => (x.get('Id') || '') === id); }
function swapAudit(req, action) { try { const a = doc.sheetsByTitle['AuditLog']; if (a) a.addRow({ Timestamp: new Date().toISOString(), Jmeno: req.user.jmeno, Email: req.user.email, Role: req.user.role, Location: req.user.location || '', Action: action }); } catch (e) {} }

// Reassign smeny na noveho cloveka: ManualShifts = update radku, Schedule = prepis jmena v bunce.
async function reassignShift(swap, newName) {
    if (swap.ShiftSheet === 'ManualShifts') {
        const ms = doc.sheetsByTitle['ManualShifts'];
        if (!ms) return { ok: false, reason: 'ManualShifts does not exist' };
        const rows = await ms.getRows();
        let target = swap.ShiftMsId ? rows.find(r => (r.get('Id') || '') === swap.ShiftMsId) : null;
        if (!target) target = rows.find(r => convertCzechDate(r.get('Date') || '') === swap.ShiftDate && (r.get('Name') || '') === swap.RequesterName && (r.get('Start') || '') === swap.ShiftStart && (r.get('Product') || '') === swap.ShiftProduct);
        if (!target) return { ok: false, reason: 'shift not found in ManualShifts' };
        target.set('Name', newName); await target.save();
        return { ok: true };
    }
    const sheet = doc.sheetsByTitle[swap.ShiftSheet];
    if (!sheet) return { ok: false, reason: 'list ' + swap.ShiftSheet + ' does not exist' };
    await sheet.loadCells('A1:BG500');
    const cell = sheet.getCell(parseInt(swap.ShiftRow, 10), parseInt(swap.ShiftCol, 10));
    const rep = replaceNameInCell(cell.value, swap.RequesterName, newName);
    if (!rep.replaced) return { ok: false, reason: 'name not found in cell (the schedule changed in the meantime)' };
    cell.value = rep.value; await sheet.saveUpdatedCells();
    return { ok: true };
}

// Board (z pohledu uzivatele)
app.get('/api/swaps', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const all = await readSwaps(await getSwapSheet());
        res.json({ board: buildBoard(all, req.user.jmeno, isManager(req.user)), isManager: isManager(req.user), me: req.user.jmeno });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vytvor zadost (z vlastni smeny)
app.post('/api/swaps', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const s = req.body || {};
    const mgr = isManager(req.user);
    // The "from" person = the shift owner. Self-service: owner === current user. Manager-on-behalf: owner = the shift's person.
    const owner = (s.name && mgr) ? s.name : req.user.jmeno;
    const vErr = validateNewRequest({ name: s.name, date: s.date, product: s.product, start: s.start }, req.user.jmeno, mgr)
        || validateNoTemplateChars(s.product, s.trading, s.note, s.date, s.name);
    if (vErr) return res.status(400).json({ error: vErr });
    try {
        const sheet = await getSwapSheet();
        const all = await readSwaps(sheet);
        if (all.find(r => (r.Status === 'OPEN' || r.Status === 'CLAIMED') && r.RequesterName === owner && r.ShiftDate === s.date && r.ShiftProduct === s.product && r.ShiftStart === s.start))
            return res.status(409).json({ error: 'This shift already has an active request' });
        const now = new Date().toISOString();
        await sheet.addRow({
            Id: crypto.randomUUID(), CreatedAt: now,
            RequesterName: owner, RequesterEmail: req.user.email,
            ShiftDate: s.date, ShiftProduct: s.product, ShiftTrading: s.trading || '', ShiftStart: s.start, ShiftEnd: s.end || '',
            ShiftSheet: s.sheet || '', ShiftRow: s.row != null ? String(s.row) : '', ShiftCol: s.col != null ? String(s.col) : '', ShiftMsId: s.msId || '',
            Note: s.note || '', Status: 'OPEN', ClaimedBy: '', ClaimedByEmail: '', UpdatedAt: now, ResolvedBy: ''
        });
        invalidateCache();
        swapAudit(req, 'SWAP_CREATE|' + owner + '|' + s.product + '|' + s.date);
        sendSlackMessage(':twisted_rightwards_arrows: *Swap request* — ' + owner + ' offers ' + s.product + ' ' + s.date + ' (' + s.start + '-' + (s.end || '') + ')' + (s.note ? ' — ' + s.note : ''));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Prevzit
app.post('/api/swaps/:id/claim', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sheet = await getSwapSheet();
        const row = await findSwapRow(sheet, req.params.id);
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (!canClaim(swapRowToObj(row), req.user.jmeno)) return res.status(409).json({ error: 'This request cannot be taken' });
        row.set('Status', 'CLAIMED'); row.set('ClaimedBy', req.user.jmeno); row.set('ClaimedByEmail', req.user.email); row.set('UpdatedAt', new Date().toISOString());
        await row.save();
        invalidateCache();
        swapAudit(req, 'SWAP_CLAIM|' + req.user.jmeno + '|' + row.get('ShiftProduct') + '|' + row.get('ShiftDate'));
        sendSlackMessage(':raising_hand: *Swap taken* — ' + req.user.jmeno + ' takes ' + row.get('ShiftProduct') + ' ' + row.get('ShiftDate') + ' from ' + row.get('RequesterName') + ' (awaiting approval)');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Schvalit -> reassign
app.post('/api/swaps/:id/approve', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sheet = await getSwapSheet();
        const row = await findSwapRow(sheet, req.params.id);
        if (!row) return res.status(404).json({ error: 'Request not found' });
        const obj = swapRowToObj(row);
        if (!canApprove(obj, req.user.jmeno, isManager(req.user))) return res.status(403).json({ error: 'Only the requester or an admin can approve' });
        const r = await reassignShift(obj, obj.ClaimedBy);
        if (!r.ok) return res.status(409).json({ error: 'Shift reassignment failed: ' + r.reason });
        row.set('Status', 'APPROVED'); row.set('ResolvedBy', req.user.jmeno); row.set('UpdatedAt', new Date().toISOString());
        await row.save();
        invalidateCache();
        swapAudit(req, 'SWAP_APPROVE|' + obj.RequesterName + '->' + obj.ClaimedBy + '|' + obj.ShiftProduct + '|' + obj.ShiftDate);
        sendSlackMessage(':white_check_mark: *Swap approved* — ' + obj.ShiftProduct + ' ' + obj.ShiftDate + ' moves from ' + obj.RequesterName + ' to ' + obj.ClaimedBy + ' (approved by ' + req.user.jmeno + ')');
        try { notifyShiftChange(req.user.jmeno, obj.ClaimedBy, 'assigned', obj.ShiftProduct + ' on ' + obj.ShiftDate + ' (' + obj.ShiftStart + '-' + obj.ShiftEnd + ')', obj.ShiftStart, obj.ShiftEnd); } catch (e) {}
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Zrusit
app.post('/api/swaps/:id/cancel', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sheet = await getSwapSheet();
        const row = await findSwapRow(sheet, req.params.id);
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (!canCancel(swapRowToObj(row), req.user.jmeno, isManager(req.user))) return res.status(403).json({ error: 'Only the requester or an admin can cancel' });
        row.set('Status', 'CANCELLED'); row.set('ResolvedBy', req.user.jmeno); row.set('UpdatedAt', new Date().toISOString());
        await row.save();
        invalidateCache();
        swapAudit(req, 'SWAP_CANCEL|' + row.get('ShiftProduct') + '|' + row.get('ShiftDate'));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Web Push endpoints =====
app.get('/api/push/key', (req, res) => { res.json({ enabled: PUSH_ENABLED, key: VAPID_PUBLIC }); });
app.post('/api/push/subscribe', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!PUSH_ENABLED) return res.status(503).json({ error: 'Push not configured' });
    const sub = req.body && req.body.sub;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    try {
        const sheet = await getPushSheet();
        const rows = await sheet.getRows();
        const existing = rows.find(r => r.get('Endpoint') === sub.endpoint);
        if (existing) { existing.set('Jmeno', req.user.jmeno); existing.set('Sub', JSON.stringify(sub)); await existing.save(); }
        else { await sheet.addRow({ Jmeno: req.user.jmeno, Email: req.user.email, Endpoint: sub.endpoint, Sub: JSON.stringify(sub), CreatedAt: new Date().toISOString() }, { raw: true }); }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/push/unsubscribe', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sheet = await getPushSheet();
        const rows = await sheet.getRows();
        for (const r of rows.filter(r => r.get('Endpoint') === (req.body && req.body.endpoint))) { try { await r.delete(); } catch (_) {} }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/push/test', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!PUSH_ENABLED) return res.status(503).json({ error: 'Push not configured' });
    try { await sendPushToUser(req.user.jmeno, 'Drachir.gg', 'Test notification — push works! 🔔', '/dashboard'); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== In-app notifications endpoints =====
app.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sheet = await getNotifSheet();
        const rows = await sheet.getRows();
        const mine = rows.filter(r => (r.get('Jmeno') || '') === req.user.jmeno).slice(-40).reverse();
        const items = mine.map(r => ({ text: r.get('Text') || '', url: r.get('Url') || '/dashboard', createdAt: r.get('CreatedAt') || '', read: String(r.get('Read')) === 'true' }));
        res.json({ items: items, unread: items.filter(i => !i.read).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sheet = await getNotifSheet();
        const rows = await sheet.getRows();
        for (const r of rows) { if ((r.get('Jmeno') || '') === req.user.jmeno && String(r.get('Read')) !== 'true') { r.set('Read', 'true'); await r.save(); } }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POINT 2: EXCHANGE SHIFT - swap names in two cells
app.post('/exchange-shift', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    const { sheet1, row1, col1, name1, date1, product1, sheet2, row2, col2, name2, date2, product2 } = req.body;
    try {
        await doc.loadInfo();
        const s1 = doc.sheetsByTitle[sheet1];
        const s2 = doc.sheetsByTitle[sheet2];
        if (!s1 || !s2) return res.status(404).send('Sheet not found');
        await s1.loadCells('A1:BG500');
        if (sheet1 !== sheet2) await s2.loadCells('A1:BG500');
        const cell1 = s1.getCell(parseInt(row1), parseInt(col1));
        const cell2 = s2.getCell(parseInt(row2), parseInt(col2));
        // Zamena jmen
        const tmp = cell1.value;
        cell1.value = name2;
        cell2.value = name1;
        await s1.saveUpdatedCells();
        if (sheet1 !== sheet2) await s2.saveUpdatedCells();
        invalidateCache();
        // AuditLog — zapis EDIT_SHIFT pro oba shifty, aby se zobrazily v Recent Activity
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet) {
                const ts = new Date().toISOString();
                const base = { Email: req.user.email, Role: req.user.role, Location: req.user.location||'' };
                // Shift 1 dostal name2 (vymeneno)
                if (date1 && product1) await auditSheet.addRow({ ...base, Timestamp: ts, Jmeno: req.user.jmeno, Action: 'EDIT_SHIFT|' + name2 + '|' + product1 + '|' + date1 });
                // Shift 2 dostal name1 (vymeneno)
                if (date2 && product2) await auditSheet.addRow({ ...base, Timestamp: ts, Jmeno: req.user.jmeno, Action: 'EDIT_SHIFT|' + name1 + '|' + product2 + '|' + date2 });
                // Obecny zaznam exchange pro historii
                await auditSheet.addRow({ ...base, Timestamp: ts, Jmeno: req.user.jmeno, Action: 'EXCHANGE: ' + name1 + ' <-> ' + name2 });
            }
        } catch(e) {}
        // Slack notifikace
        sendSlackMessage(':arrows_counterclockwise: *Shift exchange* by ' + req.user.jmeno + ': ' + name1 + ' <-> ' + name2);
        notifyShiftChange(req.user.jmeno, name1, 'exchanged', name1 + ' ↔ ' + name2 + ' on ' + (date1 || ''));
        notifyShiftChange(req.user.jmeno, name2, 'exchanged', name1 + ' ↔ ' + name2 + ' on ' + (date2 || ''));
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

// BOD 5: DELETE ALL SHIFTS FOR MONTH - Admin only
app.post('/delete-month', async (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    if (req.user.role !== 'Admin') return res.status(403).send('Admin only');
    const { sheetTitle } = req.body;
    if (!sheetTitle) return res.status(400).send('Missing sheetTitle');
    try {
        // Parse month/year from sheetTitle like "Schedule - May 2026"
        const monthNames = {'January':1,'February':2,'March':3,'April':4,'May':5,'June':6,'July':7,'August':8,'September':9,'October':10,'November':11,'December':12};
        const m = sheetTitle.match(/Schedule\s*-\s*(\w+)\s+(\d{4})/);
        if (!m) return res.status(400).send('Cannot parse month from: ' + sheetTitle);
        const targetMonth = monthNames[m[1]];
        const targetYear = parseInt(m[2]);
        if (!targetMonth) return res.status(400).send('Unknown month: ' + m[1]);

        // Delete matching rows from ManualShifts
        await doc.loadInfo();
        const manualSheet = doc.sheetsByTitle['ManualShifts'];
        let deletedCount = 0;
        if (manualSheet) {
            await manualSheet.loadCells('A1:Z500');
            let mColDate = -1;
            for (let c = 0; c < 10; c++) {
                if (manualSheet.getCell(0, c).value?.toString().trim().toLowerCase() === 'date') { mColDate = c; break; }
            }
            if (mColDate >= 0) {
                // Collect rows to delete (bottom-up to avoid index shifting)
                const rows = await manualSheet.getRows();
                const toDelete = [];
                for (let i = 0; i < rows.length; i++) {
                    const rawD = manualSheet.getCell(i + 1, mColDate).value;
                    const d = convertCzechDate(rawD);
                    if (!d) continue;
                    const [y, mo] = d.split('-').map(Number);
                    if (y === targetYear && mo === targetMonth) toDelete.push(i);
                }
                // Delete bottom-up
                for (let i = toDelete.length - 1; i >= 0; i--) {
                    await rows[toDelete[i]].delete();
                    deletedCount++;
                }
            }
        }

        // Hide the Schedule sheet so those shifts don't reappear on reload
        // (force sync via ?sync=1 will clear _hiddenSheets and bring them back)
        if (!_hiddenSheets) _hiddenSheets = new Set();
        _hiddenSheets.add(sheetTitle);

        // Invalidate cache
        _shiftsCache = null;
        _shiftsCacheTime = 0;

        // AuditLog
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet) {
                await auditSheet.addRow({
                    Timestamp: new Date().toISOString(),
                    Jmeno: req.user.jmeno,
                    Email: req.user.email,
                    Role: req.user.role,
                    Location: req.user.location || '',
                    Action: 'DELETE_MONTH_MANUAL: ' + sheetTitle + ' (' + deletedCount + ' rows deleted from ManualShifts)'
                });
            }
        } catch(e) {}

        res.json({ success: true, deleted: deletedCount, info: deletedCount + ' manual shifts deleted for ' + m[1] + ' ' + targetYear });
    } catch(e) { res.status(500).send(e.message); }
});

// --- SLACK SUBSCRIPTIONS API ---

app.get('/api/slack-subscriptions', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!_slackDataLoaded) await loadSlackData();
    const mySubs = _slackSubscriptions.filter(s => s.subscriber === req.user.jmeno).map(s => s.target);
    res.json({ subscriptions: mySubs });
});

app.post('/api/slack-subscriptions', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { target, action } = req.body; // action: 'add' or 'remove'
    if (!target || !action) return res.status(400).json({ error: 'Missing target or action' });
    try {
        await doc.loadInfo();
        let subSheet = doc.sheetsByTitle['SlackSubscriptions'];
        if (!subSheet) {
            subSheet = await doc.addSheet({ title: 'SlackSubscriptions', headerValues: ['Subscriber', 'Target'] });
        }
        if (action === 'add') {
            // Check duplicate
            const exists = _slackSubscriptions.some(s => s.subscriber === req.user.jmeno && s.target === target);
            if (!exists) {
                await subSheet.addRow({ Subscriber: req.user.jmeno, Target: target });
                _slackSubscriptions.push({ subscriber: req.user.jmeno, target });
            }
        } else if (action === 'remove') {
            const rows = await subSheet.getRows();
            const row = rows.find(r => r.get('Subscriber') === req.user.jmeno && r.get('Target') === target);
            if (row) await row.delete();
            _slackSubscriptions = _slackSubscriptions.filter(s => !(s.subscriber === req.user.jmeno && s.target === target));
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- STATS ---

app.get('/stats', async (req, res) => {
    if (!req.user) return res.redirect('/');

    // Stats visible to everyone — every user sees full team data (same as admin)
    const canSeeAll = true;

    let selectedPerson = req.query.person || null;

    // Anchor date
    const anchorDate = req.query.date ? new Date(req.query.date) : new Date();
    anchorDate.setHours(12,0,0,0);

    // Three ranges: day, week (Mon–Sun of anchor), month (of anchor)
    const dayStart = new Date(anchorDate); dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(anchorDate); dayEnd.setHours(23,59,59,999);
    const weekStart = new Date(anchorDate);
    const wDow = weekStart.getDay() || 7;
    weekStart.setHours(0,0,0,0);
    weekStart.setDate(weekStart.getDate() - (wDow - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23,59,59,999);
    const monthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const monthEnd = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0);
    monthEnd.setHours(23,59,59,999);

    const dayLabel = anchorDate.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const weekLabel = weekStart.toLocaleDateString('en-GB', { day:'numeric', month:'short' }) + ' &ndash; ' + weekEnd.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
    const monthLabel = anchorDate.toLocaleDateString('en-GB', { month:'long', year:'numeric' });

    // Prev/next day navigation
    const pd = new Date(anchorDate); pd.setDate(pd.getDate() - 1);
    const nd = new Date(anchorDate); nd.setDate(nd.getDate() + 1);
    const prevDate = toISOLocal(pd);
    const nextDate = toISOLocal(nd);

    try {
        const rawShifts = await loadAllShifts(false);

        // Dedupe: same shift can appear in both Schedule sheet and ManualShifts.
        // Prefer ManualShifts (it overrides the planner). Key = Date|Name|Product|Start|End.
        const _dedupMap = {};
        rawShifts.forEach(s => {
            const key = s.Date + '|' + s.Name + '|' + (s.Product || '') + '|' + s.Start + '|' + s.End;
            if (!_dedupMap[key] || s._manual) _dedupMap[key] = s;
        });
        const allShifts = Object.values(_dedupMap);

        // Classify shift type by start hour
        function classifyShift(shift) {
            const startH = parseInt(shift.Start.split(':')[0]);
            let shiftType = 'other';
            if (startH === 7 || startH === 8) shiftType = 'morning';
            else if (startH === 15 || startH === 16) shiftType = 'afternoon';
            else if (startH === 23 || startH === 0) shiftType = 'night';
            return { shiftType, isRIP: shift.Product === 'RIP', isVacation: shift.Product === 'Vacation' };
        }

        function computeStats(rangeStart, rangeEnd) {
            const rangeDays = Math.round((rangeEnd - rangeStart) / (1000*60*60*24)) + 1;
            const rangeWeeks = rangeDays / 7;
            const map = {};
            peopleHierarchy.forEach(group => {
                group.members.forEach(name => {
                    if (!canSeeAll && name !== req.user.jmeno) return;
                    map[name] = {
                        name, group: group.label, groupColor: group.color,
                        personColor: personColors[name] || '#666',
                        targetWeekly: group.target,
                        targetPeriod: Math.round(group.target * rangeWeeks * 10) / 10,
                        totalHours: 0, ripCount: 0, vacationCount: 0,
                        morningCount: 0, afternoonCount: 0, nightCount: 0,
                        totalShifts: 0
                    };
                });
            });
            allShifts.forEach(s => {
                const d = new Date(s.Date);
                if (d < rangeStart || d > rangeEnd) return;
                const stats = map[s.Name];
                if (!stats) return;
                const cls = classifyShift(s);
                if (cls.isRIP) { stats.ripCount++; stats.totalShifts++; return; }
                if (cls.isVacation) { stats.vacationCount++; stats.totalShifts++; return; }
                stats.totalHours += calculateDuration(s.Start, s.End);
                stats.totalShifts++;
                if (cls.shiftType === 'morning') stats.morningCount++;
                else if (cls.shiftType === 'afternoon') stats.afternoonCount++;
                else if (cls.shiftType === 'night') stats.nightCount++;
            });
            return map;
        }

        const dayMap = computeStats(dayStart, dayEnd);
        const weekMap = computeStats(weekStart, weekEnd);
        const monthMap = computeStats(monthStart, monthEnd);

        // Legacy aliases so downstream code (sidebar) keeps compiling — sidebar shows MONTH totals
        const statsMap = monthMap;
        const statsArr = Object.values(monthMap);
        const periodStart = monthStart, periodEnd = monthEnd;

        // ========== TRADING BREAKDOWN (Fáze 6A) ==========
        // tclean: názvy z dat (Trading/Product) jdou do ${mainHTML} template literalu — odstranit backtick/${ + HTML
        const tclean = (v) => String(v == null ? '' : v).replace(/`/g, "'").replace(/\$\{/g, '$ {').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const TRADING_PALETTE = ['#60a5fa','#f59e0b','#a78bfa','#34d399','#f472b6','#22d3ee','#fb7185','#facc15','#4ade80','#38bdf8','#fdba74','#c084fc'];
        const shiftsInRange = (rs, re) => allShifts.filter(s => { const d = new Date(s.Date); return d >= rs && d <= re; });
        // Stejná populace jako team KPI (computeStats počítá jen členy peopleHierarchy) — ať team panely nesedí rozdílně
        const teamMemberSet = new Set(peopleHierarchy.flatMap(g => g.members));
        function renderTradingPanel(rangeShifts, title, periodLabel) {
            const bd = buildTradingBreakdown(rangeShifts, calculateDuration, { excludeProducts: ['RIP', 'Vacation'] });
            if (!bd.categories.length) {
                return '<div class="panel"><div class="panel-header"><div class="panel-title">' + title + '</div><div class="panel-sub">' + periodLabel + '</div></div><div style="padding:26px;text-align:center;color:#4a5060;font-size:0.82rem;font-family:Oswald;letter-spacing:1px;">NO TRADING SHIFTS</div></div>';
            }
            const maxH = Math.max(1, ...bd.categories.map(c => c.hours));
            let rows = '';
            bd.categories.forEach((c, i) => {
                const col = TRADING_PALETTE[i % TRADING_PALETTE.length];
                const barPct = (c.hours / maxH) * 100;
                rows += '<div style="margin-bottom:12px;"><div style="display:flex;align-items:center;gap:10px;">'
                    + '<span style="width:10px;height:10px;border-radius:2px;background:' + col + ';flex-shrink:0;"></span>'
                    + '<span style="flex:1;font-weight:600;color:#dfe6f2;">' + tclean(c.trading) + '</span>'
                    + '<span style="color:#aab4c8;font-size:0.82rem;">' + c.hours.toFixed(1) + 'h &middot; ' + c.shifts + ' shifts</span></div>'
                    + '<div style="height:8px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden;margin-top:5px;"><div style="height:100%;width:' + barPct.toFixed(1) + '%;background:linear-gradient(90deg,' + col + ',' + col + '99);border-radius:5px;"></div></div>';
                if (c.products.length > 1) {
                    rows += '<div style="margin:7px 0 2px 20px;display:flex;flex-wrap:wrap;gap:6px;">';
                    c.products.forEach(p => { rows += '<span style="font-size:0.72rem;color:#8a94a8;background:rgba(255,255,255,0.04);border-radius:4px;padding:2px 8px;">' + tclean(p.product) + ' <b style="color:#c8d0e0;">' + p.hours.toFixed(1) + 'h</b></span>'; });
                    rows += '</div>';
                }
                rows += '</div>';
            });
            return '<div class="panel"><div class="panel-header"><div class="panel-title">' + title + '</div><div class="panel-sub">' + bd.categories.length + ' categories &middot; ' + bd.totalHours.toFixed(1) + 'h &middot; ' + bd.totalShifts + ' shifts</div></div><div style="padding:6px 2px;">' + rows + '</div></div>';
        }

        // Pokrytí (Fáze 6B): očekávané sloty (productCoverage) vs odsloužené, per produkt, nejhorší první
        function renderCoveragePanel(periodLabel) {
            const periodDates = [];
            for (let dd = new Date(monthStart); dd <= monthEnd; dd.setDate(dd.getDate() + 1)) periodDates.push(toISOLocal(dd));
            const profiles = productMapping.map(p => { const c = getCoverageProfile(p.name); return { name: p.name, slots: c.slots, days: c.days }; });
            const cov = buildCoverage(shiftsInRange(monthStart, monthEnd), profiles, periodDates);
            const barColor = (pct) => pct >= 95 ? '#4ade80' : (pct >= 80 ? '#facc15' : '#f87171');
            let rows = '';
            cov.products.forEach(p => {
                const col = barColor(p.pct);
                const gapTxt = p.gaps > 0
                    ? (p.gaps + ' missing &middot; ' + p.gapDates.length + ' day' + (p.gapDates.length !== 1 ? 's' : '') + ' with gaps')
                    : 'fully covered';
                rows += '<div style="margin-bottom:11px;"><div style="display:flex;align-items:center;gap:10px;">'
                    + '<span style="flex:1;font-weight:600;color:#dfe6f2;">' + tclean(p.product) + '</span>'
                    + '<span style="color:#aab4c8;font-size:0.8rem;">' + p.covered + '/' + p.expected + ' slots</span>'
                    + '<span style="color:' + col + ';font-weight:700;font-size:0.82rem;min-width:42px;text-align:right;">' + p.pct + '%</span></div>'
                    + '<div style="height:8px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden;margin-top:5px;"><div style="height:100%;width:' + p.pct + '%;background:' + col + ';border-radius:5px;"></div></div>'
                    + '<div style="font-size:0.7rem;color:' + (p.gaps > 0 ? '#c08a8a' : '#5a7a5a') + ';margin-top:3px;">' + gapTxt + '</div></div>';
            });
            const headColor = barColor(cov.pct);
            return '<div class="panel"><div class="panel-header"><div class="panel-title">COVERAGE</div><div class="panel-sub">' + periodLabel + ' &middot; <span style="color:' + headColor + ';font-weight:700;">' + cov.pct + '%</span> &middot; ' + cov.totalCovered + '/' + cov.totalExpected + ' slots</div></div><div style="padding:6px 2px;">' + rows + '</div></div>';
        }

        // ========== SIDEBAR HTML ==========
        const periodQs = 'date=' + toISOLocal(anchorDate);
        let sidebarHTML = '';
        if (canSeeAll) {
            sidebarHTML += '<a href="/stats?' + periodQs + '" class="nav-item ' + (!selectedPerson ? 'active' : '') + '"><span class="nav-ico">&#128202;</span><span>TEAM OVERVIEW</span></a>';
            peopleHierarchy.forEach(group => {
                const gid = group.label.replace(/[^a-z0-9]/gi, '');
                const memberCount = group.members.length;
                sidebarHTML += '<div class="nav-group">';
                sidebarHTML += '<div class="nav-group-header" onclick="toggleNavGroup(\'' + gid + '\')"><span class="ng-dot" style="background:' + group.color + '"></span><span class="ng-label">' + group.label + '</span><span class="ng-count">' + memberCount + '</span><span class="ng-arrow" id="arr_' + gid + '">&#9660;</span></div>';
                sidebarHTML += '<div class="nav-group-items" id="grp_' + gid + '">';
                const members = [...group.members].sort();
                members.forEach(name => {
                    const st = statsMap[name];
                    const hrs = st ? st.totalHours.toFixed(1) : '0';
                    const active = selectedPerson === name ? 'active' : '';
                    const color = personColors[name] || '#666';
                    const initial = name.charAt(0).toUpperCase();
                    sidebarHTML += '<a href="/stats?person=' + encodeURIComponent(name) + '&' + periodQs + '" class="person-item ' + active + '"><span class="pi-avatar" style="background:' + color + '">' + initial + '</span><span class="pi-name">' + name + '</span><span class="pi-hrs">' + hrs + 'h</span></a>';
                });
                sidebarHTML += '</div></div>';
            });
        } else {
            const me = statsMap[req.user.jmeno];
            if (me) {
                sidebarHTML += '<div style="padding:16px;color:#4a5060;font-size:0.75rem;text-align:center;letter-spacing:1.5px;font-family:Oswald;">YOUR STATS</div>';
                sidebarHTML += '<a href="/stats?' + periodQs + '" class="person-item active"><span class="pi-avatar" style="background:' + me.personColor + '">' + me.name.charAt(0).toUpperCase() + '</span><span class="pi-name">' + me.name + '</span><span class="pi-hrs">' + me.totalHours.toFixed(1) + 'h</span></a>';
            }
        }

        // ========== MAIN CONTENT ==========
        let mainHTML = '';

        function shiftTypeTag(s) {
            const cls = classifyShift(s);
            let typeColor = '#555', typeLabel = 'OTHER';
            if (cls.isRIP) { typeColor = '#ef5350'; typeLabel = 'RIP'; }
            else if (cls.isVacation) { typeColor = '#9e9e9e'; typeLabel = 'VAC'; }
            else if (cls.shiftType === 'morning') { typeColor = '#ffa726'; typeLabel = 'MORNING'; }
            else if (cls.shiftType === 'afternoon') { typeColor = '#42a5f5'; typeLabel = 'AFTERNOON'; }
            else if (cls.shiftType === 'night') { typeColor = '#7c4dff'; typeLabel = 'NIGHT'; }
            return { typeColor, typeLabel };
        }

        function buildShiftList(shifts) {
            if (!shifts || shifts.length === 0) {
                return '<div style="padding:26px;text-align:center;color:#4a5060;font-size:0.82rem;font-family:Oswald;letter-spacing:1px;">NO SHIFTS</div>';
            }
            let h = '';
            shifts.forEach(s => {
                const d = new Date(s.Date + 'T12:00:00');
                const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
                const date = d.getDate() + '.' + (d.getMonth() + 1) + '.';
                const { typeColor, typeLabel } = shiftTypeTag(s);
                const prod = tclean(s.Product || s.Trading || '');
                h += '<div class="shift-item"><div class="shift-date"><div class="sd-day">' + day + '</div><div class="sd-num">' + date + '</div></div><div class="shift-body"><div class="shift-prod">' + prod + '</div><div class="shift-time">' + s.Start + ' &rarr; ' + s.End + '</div></div><div class="shift-type" style="background:' + typeColor + '22;color:' + typeColor + ';border:1px solid ' + typeColor + '44;">' + typeLabel + '</div></div>';
            });
            return h;
        }

        function personKPIs(p) {
            if (!p) return '';
            const pct = p.targetPeriod > 0 ? Math.round((p.totalHours / p.targetPeriod) * 100) : 0;
            let h = '<div class="kpi-grid">';
            h += '<div class="kpi-card kpi-hours"><div class="kpi-ico">&#9201;</div><div class="kpi-val">' + p.totalHours.toFixed(1) + '<span class="kpi-unit">h</span></div><div class="kpi-lbl">Total Hours</div><div class="kpi-sub">Target ' + p.targetPeriod.toFixed(0) + 'h &middot; ' + pct + '%</div></div>';
            h += '<div class="kpi-card kpi-morning"><div class="kpi-ico">&#9728;</div><div class="kpi-val">' + p.morningCount + '</div><div class="kpi-lbl">Morning</div><div class="kpi-sub">07:00 &ndash; 16:00</div></div>';
            h += '<div class="kpi-card kpi-afternoon"><div class="kpi-ico">&#127773;</div><div class="kpi-val">' + p.afternoonCount + '</div><div class="kpi-lbl">Afternoon</div><div class="kpi-sub">15:00 &ndash; 00:00</div></div>';
            h += '<div class="kpi-card kpi-night"><div class="kpi-ico">&#127769;</div><div class="kpi-val">' + p.nightCount + '</div><div class="kpi-lbl">Night</div><div class="kpi-sub">23:00 &ndash; 08:00</div></div>';
            h += '<div class="kpi-card kpi-rip"><div class="kpi-ico">&#9888;</div><div class="kpi-val">' + p.ripCount + '</div><div class="kpi-lbl">RIP</div><div class="kpi-sub">Shifts</div></div>';
            h += '<div class="kpi-card kpi-vacation"><div class="kpi-ico">&#127796;</div><div class="kpi-val">' + p.vacationCount + '</div><div class="kpi-lbl">Vacation</div><div class="kpi-sub">Shifts</div></div>';
            h += '</div>';
            return h;
        }

        function sectionHead(eyebrow, title) {
            return '<div class="section-head"><div class="sh-eyebrow">' + eyebrow + '</div><div class="sh-title">' + title + '</div></div>';
        }

        if (selectedPerson && statsMap[selectedPerson]) {
            // === PERSON DETAIL VIEW ===
            const pMonth = monthMap[selectedPerson];
            const pWeek = weekMap[selectedPerson];
            const pDay = dayMap[selectedPerson];

            // Collect shifts per range for this person
            const dayShifts = [], weekShifts = [], monthShifts = [];
            allShifts.forEach(s => {
                if (s.Name !== selectedPerson) return;
                const d = new Date(s.Date);
                if (d >= dayStart && d <= dayEnd) dayShifts.push(s);
                if (d >= weekStart && d <= weekEnd) weekShifts.push(s);
                if (d >= monthStart && d <= monthEnd) monthShifts.push(s);
            });
            const sortFn = (a,b) => b.Date.localeCompare(a.Date) || a.Start.localeCompare(b.Start);
            dayShifts.sort(sortFn); weekShifts.sort(sortFn); monthShifts.sort(sortFn);

            const monthPct = pMonth.targetPeriod > 0 ? Math.round((pMonth.totalHours / pMonth.targetPeriod) * 100) : 0;
            const progressColor = monthPct >= 100 ? '#4caf50' : monthPct >= 80 ? '#fbc02d' : '#f44336';

            // Hero
            mainHTML += '<div class="hero"><div class="hero-avatar" style="background:' + pMonth.personColor + '">' + pMonth.name.charAt(0).toUpperCase() + '</div><div class="hero-info"><div class="hero-eyebrow">' + pMonth.group.toUpperCase() + '</div><div class="hero-name">' + pMonth.name + '</div><div class="hero-meta">' + pMonth.totalShifts + ' shifts &middot; ' + pMonth.totalHours.toFixed(1) + 'h in ' + monthLabel + '</div></div><div class="hero-progress"><div class="hp-circle" style="background:conic-gradient(' + progressColor + ' ' + (monthPct * 3.6) + 'deg, #1a1c28 0deg);"><div class="hp-inner"><div class="hp-val">' + monthPct + '%</div><div class="hp-lbl">OF MONTH</div></div></div></div></div>';

            // === DAY SECTION ===
            mainHTML += sectionHead('DAY', dayLabel);
            mainHTML += personKPIs(pDay);
            mainHTML += '<div class="panel"><div class="panel-header"><div class="panel-title">SHIFTS THIS DAY</div><div class="panel-sub">' + dayShifts.length + ' shift' + (dayShifts.length !== 1 ? 's' : '') + '</div></div><div class="shifts-list">' + buildShiftList(dayShifts) + '</div></div>';

            // === WEEK SECTION ===
            mainHTML += sectionHead('WEEK', weekLabel);
            mainHTML += personKPIs(pWeek);
            mainHTML += '<div class="panel"><div class="panel-header"><div class="panel-title">SHIFTS THIS WEEK</div><div class="panel-sub">' + weekShifts.length + ' shifts</div></div><div class="shifts-list">' + buildShiftList(weekShifts) + '</div></div>';

            // === MONTH SECTION (chart + donut + list) ===
            const dailyHours = {};
            for (let dd = new Date(monthStart); dd <= monthEnd; dd.setDate(dd.getDate() + 1)) {
                dailyHours[toISOLocal(dd)] = 0;
            }
            monthShifts.forEach(s => {
                if (s.Product === 'RIP' || s.Product === 'Vacation') return;
                if (dailyHours[s.Date] !== undefined) dailyHours[s.Date] += calculateDuration(s.Start, s.End);
            });
            const daysArr = Object.keys(dailyHours).sort();
            const maxDayH = Math.max(8, ...Object.values(dailyHours));
            const chartW = 800, chartH = 220, padL = 40, padR = 20, padT = 20, padB = 40;
            const plotW = chartW - padL - padR;
            const plotH = chartH - padT - padB;
            let linePts = '', areaPts = 'M ' + padL + ',' + (padT + plotH);
            daysArr.forEach((day, i) => {
                const x = padL + (i / Math.max(1, daysArr.length - 1)) * plotW;
                const y = padT + plotH - (dailyHours[day] / maxDayH) * plotH;
                linePts += (i === 0 ? 'M ' : ' L ') + x.toFixed(1) + ',' + y.toFixed(1);
                areaPts += ' L ' + x.toFixed(1) + ',' + y.toFixed(1);
            });
            areaPts += ' L ' + (padL + plotW) + ',' + (padT + plotH) + ' Z';
            let gridHTML = '';
            for (let i = 0; i <= 4; i++) {
                const y = padT + (i / 4) * plotH;
                const val = Math.round(maxDayH * (1 - i / 4));
                gridHTML += '<line x1="' + padL + '" y1="' + y + '" x2="' + (padL + plotW) + '" y2="' + y + '" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2,4"/>';
                gridHTML += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="rgba(200,210,230,0.55)" font-size="10" font-family="Inter">' + val + 'h</text>';
            }
            let xLabelsHTML = '';
            const step = Math.max(1, Math.floor(daysArr.length / 7));
            daysArr.forEach((day, i) => {
                if (i % step !== 0 && i !== daysArr.length - 1) return;
                const x = padL + (i / Math.max(1, daysArr.length - 1)) * plotW;
                const d = new Date(day + 'T12:00:00');
                const lbl = d.getDate() + '.' + (d.getMonth() + 1) + '.';
                xLabelsHTML += '<text x="' + x + '" y="' + (chartH - 12) + '" text-anchor="middle" fill="rgba(170,190,220,0.65)" font-size="10" font-family="Inter" font-weight="600">' + lbl + '</text>';
            });

            const donutR = 70, donutCx = 100, donutCy = 100;
            const donutTotal = pMonth.morningCount + pMonth.afternoonCount + pMonth.nightCount + pMonth.ripCount + pMonth.vacationCount;
            const donutCirc = 2 * Math.PI * donutR;
            let donutSegments = '';
            if (donutTotal > 0) {
                let offset = 0;
                const segs = [
                    { val: pMonth.morningCount, color: '#ffa726' },
                    { val: pMonth.afternoonCount, color: '#42a5f5' },
                    { val: pMonth.nightCount, color: '#7c4dff' },
                    { val: pMonth.ripCount, color: '#ef5350' },
                    { val: pMonth.vacationCount, color: '#26c6da' }
                ];
                segs.forEach(seg => {
                    if (seg.val === 0) return;
                    const segLen = (seg.val / donutTotal) * donutCirc;
                    donutSegments += '<circle cx="' + donutCx + '" cy="' + donutCy + '" r="' + donutR + '" fill="none" stroke="' + seg.color + '" stroke-width="22" stroke-dasharray="' + segLen + ' ' + donutCirc + '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 ' + donutCx + ' ' + donutCy + ')"/>';
                    offset += segLen;
                });
            } else {
                donutSegments = '<circle cx="' + donutCx + '" cy="' + donutCy + '" r="' + donutR + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="22"/>';
            }

            mainHTML += sectionHead('MONTH', monthLabel);
            mainHTML += personKPIs(pMonth);
            mainHTML += '<div class="two-col">';
            mainHTML += '<div class="panel panel-wide"><div class="panel-header"><div class="panel-title">HOURS TREND</div><div class="panel-sub">Daily hours across ' + monthLabel + '</div></div><div class="chart-wrap"><svg viewBox="0 0 ' + chartW + ' ' + chartH + '" style="width:100%;height:auto;"><defs><linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#60a5fa" stop-opacity="0.38"/><stop offset="100%" stop-color="#60a5fa" stop-opacity="0"/></linearGradient></defs>' + gridHTML + '<path d="' + areaPts + '" fill="url(#areaGrad)"/><path d="' + linePts + '" stroke="url(#lineGrad)" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' + xLabelsHTML + '</svg></div></div>';
            mainHTML += '<div class="panel"><div class="panel-header"><div class="panel-title">SHIFT MIX</div><div class="panel-sub">' + donutTotal + ' shifts total</div></div><div class="donut-wrap"><svg viewBox="0 0 200 200" style="width:180px;height:180px;">' + donutSegments + '<text x="100" y="96" text-anchor="middle" fill="#c8d0e0" font-size="28" font-weight="700" font-family="Oswald">' + donutTotal + '</text><text x="100" y="116" text-anchor="middle" fill="#4a5060" font-size="10" letter-spacing="2" font-family="Oswald">SHIFTS</text></svg><div class="donut-legend"><div class="dl-item"><span class="dl-dot" style="background:#ffa726"></span>Morning<span class="dl-val">' + pMonth.morningCount + '</span></div><div class="dl-item"><span class="dl-dot" style="background:#42a5f5"></span>Afternoon<span class="dl-val">' + pMonth.afternoonCount + '</span></div><div class="dl-item"><span class="dl-dot" style="background:#7c4dff"></span>Night<span class="dl-val">' + pMonth.nightCount + '</span></div><div class="dl-item"><span class="dl-dot" style="background:#ef5350"></span>RIP<span class="dl-val">' + pMonth.ripCount + '</span></div><div class="dl-item"><span class="dl-dot" style="background:#26c6da"></span>Vacation<span class="dl-val">' + pMonth.vacationCount + '</span></div></div></div></div>';
            mainHTML += '</div>';
            mainHTML += '<div class="panel"><div class="panel-header"><div class="panel-title">ALL SHIFTS THIS MONTH</div><div class="panel-sub">' + monthShifts.length + ' shifts</div></div><div class="shifts-list">' + buildShiftList(monthShifts) + '</div></div>';
            mainHTML += renderTradingPanel(monthShifts, 'TRADING BREAKDOWN', monthLabel);

        } else {
            // === TEAM OVERVIEW — three stacked sections ===

            function renderTeamSection(eyebrow, title, rangeMap) {
                const arr = Object.values(rangeMap);
                const sumHours = Math.round(arr.reduce((a,b) => a + b.totalHours, 0) * 10) / 10;
                const sumRIP = arr.reduce((a,b) => a + b.ripCount, 0);
                const sumVacation = arr.reduce((a,b) => a + b.vacationCount, 0);
                const sumMorning = arr.reduce((a,b) => a + b.morningCount, 0);
                const sumAfternoon = arr.reduce((a,b) => a + b.afternoonCount, 0);
                const sumNight = arr.reduce((a,b) => a + b.nightCount, 0);
                const activePeople = arr.filter(s => s.totalShifts > 0).length;
                const maxH = Math.max(1, ...arr.map(s => s.totalHours));

                let s = sectionHead(eyebrow, title);
                s += '<div class="kpi-grid">';
                s += '<div class="kpi-card kpi-hours"><div class="kpi-ico">&#9201;</div><div class="kpi-val">' + sumHours + '<span class="kpi-unit">h</span></div><div class="kpi-lbl">Total Hours</div><div class="kpi-sub">' + activePeople + ' people</div></div>';
                s += '<div class="kpi-card kpi-morning"><div class="kpi-ico">&#9728;</div><div class="kpi-val">' + sumMorning + '</div><div class="kpi-lbl">Morning</div><div class="kpi-sub">Shifts</div></div>';
                s += '<div class="kpi-card kpi-afternoon"><div class="kpi-ico">&#127773;</div><div class="kpi-val">' + sumAfternoon + '</div><div class="kpi-lbl">Afternoon</div><div class="kpi-sub">Shifts</div></div>';
                s += '<div class="kpi-card kpi-night"><div class="kpi-ico">&#127769;</div><div class="kpi-val">' + sumNight + '</div><div class="kpi-lbl">Night</div><div class="kpi-sub">Shifts</div></div>';
                s += '<div class="kpi-card kpi-rip"><div class="kpi-ico">&#9888;</div><div class="kpi-val">' + sumRIP + '</div><div class="kpi-lbl">RIP</div><div class="kpi-sub">Shifts</div></div>';
                s += '<div class="kpi-card kpi-vacation"><div class="kpi-ico">&#127796;</div><div class="kpi-val">' + sumVacation + '</div><div class="kpi-lbl">Vacation</div><div class="kpi-sub">Shifts</div></div>';
                s += '</div>';

                peopleHierarchy.forEach(group => {
                    const gMembers = arr.filter(x => x.group === group.label);
                    if (gMembers.length === 0) return;
                    gMembers.sort((a,b) => b.totalHours - a.totalHours);
                    const gTotal = gMembers.reduce((a,b) => a + b.totalHours, 0);

                    let rowsHTML = '';
                    gMembers.forEach(x => {
                        const barPct = maxH > 0 ? (x.totalHours / maxH) * 100 : 0;
                        const targetPct = x.targetPeriod > 0 ? Math.round((x.totalHours / x.targetPeriod) * 100) : 0;
                        rowsHTML += '<a href="/stats?person=' + encodeURIComponent(x.name) + '&' + periodQs + '" class="team-row"><span class="tr-avatar" style="background:' + x.personColor + '">' + x.name.charAt(0).toUpperCase() + '</span><span class="tr-name">' + x.name + '</span><div class="tr-bar-wrap"><div class="tr-bar" style="width:' + barPct.toFixed(1) + '%;background:linear-gradient(90deg,' + x.personColor + ',' + x.personColor + '99);"></div></div><span class="tr-hours">' + x.totalHours.toFixed(1) + 'h</span><span class="tr-target">' + (x.targetPeriod > 0 ? targetPct + '%' : '-') + '</span><span class="tr-counts"><span style="color:#ffa726" title="Morning">' + (x.morningCount||0) + '</span>&middot;<span style="color:#42a5f5" title="Afternoon">' + (x.afternoonCount||0) + '</span>&middot;<span style="color:#7c4dff" title="Night">' + (x.nightCount||0) + '</span>&middot;<span style="color:#ef5350" title="RIP">' + (x.ripCount||0) + '</span>&middot;<span style="color:#26c6da" title="Vacation">' + (x.vacationCount||0) + '</span></span></a>';
                    });
                    s += '<div class="panel"><div class="panel-header"><div class="panel-title" style="color:' + group.color + '">' + group.label.toUpperCase() + '</div><div class="panel-sub">' + gMembers.length + ' people &middot; ' + gTotal.toFixed(1) + 'h total</div></div><div class="team-list">' + rowsHTML + '</div></div>';
                });

                return s;
            }

            // Hero
            const hArr = Object.values(monthMap);
            const hSumHours = Math.round(hArr.reduce((a,b) => a + b.totalHours, 0) * 10) / 10;
            const hActive = hArr.filter(s => s.totalShifts > 0).length;
            mainHTML += '<div class="hero"><div class="hero-avatar" style="background:linear-gradient(135deg,#60a5fa,#3b82f6)">&#128202;</div><div class="hero-info"><div class="hero-eyebrow">TEAM OVERVIEW</div><div class="hero-name">' + dayLabel + '</div><div class="hero-meta">' + hActive + ' active people &middot; ' + hSumHours + 'h in ' + monthLabel + '</div></div></div>';

            mainHTML += renderTeamSection('DAY', dayLabel, dayMap);
            mainHTML += renderTeamSection('WEEK', weekLabel, weekMap);
            mainHTML += renderTeamSection('MONTH', monthLabel, monthMap);
            mainHTML += renderTradingPanel(shiftsInRange(monthStart, monthEnd).filter(s => teamMemberSet.has(s.Name)), 'TEAM TRADING BREAKDOWN', monthLabel);
            mainHTML += renderCoveragePanel(monthLabel);
        }

        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Statistics &ndash; Drachir.gg</title>
<link rel="icon" type="image/png" sizes="192x192" href="/images/icon-192.png">
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#04060c;color:#dfe6f2;font-family:'Inter',sans-serif;min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;}
a{text-decoration:none;color:inherit;}

/* Glass design tokens */
:root{
    --glass-fill:linear-gradient(140deg,rgba(255,255,255,0.12) 0%,rgba(255,255,255,0.04) 45%,rgba(255,255,255,0.02) 100%);
    --glass-fill-strong:linear-gradient(140deg,rgba(255,255,255,0.18) 0%,rgba(255,255,255,0.06) 45%,rgba(255,255,255,0.03) 100%);
    --glass-border:1px solid rgba(255,255,255,0.16);
    --glass-border-soft:1px solid rgba(255,255,255,0.10);
    --glass-blur:blur(34px) saturate(180%);
    --glass-blur-soft:blur(22px) saturate(160%);
    --glass-shadow:0 18px 48px rgba(0,0,0,0.45), 0 2px 0 rgba(255,255,255,0.04) inset, 0 1px 0 rgba(255,255,255,0.22) inset, 0 -20px 40px rgba(0,0,0,0.2) inset;
    --glass-shadow-lift:0 26px 60px rgba(59,130,246,0.22), 0 2px 0 rgba(255,255,255,0.06) inset, 0 1px 0 rgba(255,255,255,0.32) inset, 0 -20px 40px rgba(0,0,0,0.22) inset;
    --ease:cubic-bezier(0.4,0,0.2,1);
}

/* Shared specular highlight mixin — a thin bright stripe at the top edge */
.glass-spec{position:relative;}
.glass-spec::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.18) 0%,rgba(255,255,255,0.04) 14%,transparent 32%);mix-blend-mode:screen;opacity:0.9;}

/* Layout shell */
.shell{display:flex;min-height:100vh;}
.sidebar{width:280px;background:linear-gradient(180deg,rgba(10,14,28,0.78),rgba(4,7,16,0.82));backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);border-right:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;position:fixed;left:0;top:0;bottom:0;overflow-y:auto;z-index:10;scrollbar-width:thin;scrollbar-color:rgba(96,165,250,0.4) transparent;box-shadow:inset -1px 0 0 rgba(255,255,255,0.04), 24px 0 80px rgba(0,0,0,0.35);}
.sidebar::-webkit-scrollbar{width:6px;}
.sidebar::-webkit-scrollbar-track{background:transparent;}
.sidebar::-webkit-scrollbar-thumb{background:rgba(96,165,250,0.3);border-radius:3px;}
.sidebar::-webkit-scrollbar-thumb:hover{background:rgba(96,165,250,0.55);}
.main{margin-left:280px;flex:1;min-width:0;background:radial-gradient(ellipse 1400px 800px at 10% -10%, rgba(59,130,246,0.28) 0%, transparent 55%), radial-gradient(ellipse 1100px 650px at 100% 10%, rgba(139,92,246,0.22) 0%, transparent 55%), radial-gradient(ellipse 1000px 700px at 50% 115%, rgba(34,211,238,0.14) 0%, transparent 60%), radial-gradient(ellipse 700px 500px at 80% 60%, rgba(96,165,250,0.12) 0%, transparent 60%), linear-gradient(180deg, #050a18 0%, #040712 45%, #02040c 100%);position:relative;}
.main::before{content:'';position:fixed;top:0;left:280px;right:0;bottom:0;background-image:linear-gradient(rgba(96,165,250,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.035) 1px, transparent 1px);background-size:48px 48px;pointer-events:none;mask-image:radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, transparent 75%);-webkit-mask-image:radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, transparent 75%);z-index:0;}
.main > *{position:relative;z-index:1;}

/* Sidebar branding */
.sb-brand{padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:12px;position:relative;}
.sb-brand::after{content:'';position:absolute;left:16px;right:16px;bottom:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent);}
.sb-logo-img{width:40px;height:40px;object-fit:contain;filter:drop-shadow(0 0 12px rgba(251,192,45,0.45));}
.sb-title{font-family:'Oswald';font-weight:700;font-size:1rem;letter-spacing:2px;color:#fbc02d;text-shadow:0 1px 0 rgba(0,0,0,0.5), 0 0 14px rgba(251,192,45,0.25);}
.sb-sub{font-size:0.6rem;color:#7a8499;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;}

/* Mini calendar */
.sb-cal{margin:12px 14px 14px;padding:12px;border-radius:16px;background:var(--glass-fill);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);border:var(--glass-border-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.25), 0 10px 26px rgba(0,0,0,0.4);position:relative;}
.sb-cal::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.14) 0%,rgba(255,255,255,0.03) 16%,transparent 34%);mix-blend-mode:screen;opacity:0.85;}
.sb-cal-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.sb-cal-nav button{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#9aa4b8;cursor:pointer;padding:3px 10px;font-size:0.85rem;border-radius:999px;transition:all 0.2s var(--ease);}
.sb-cal-nav button:hover{color:#fff;background:rgba(96,165,250,0.18);border-color:rgba(96,165,250,0.35);box-shadow:0 4px 12px rgba(59,130,246,0.25);}
.sb-cal-nav span{font-size:0.65rem;color:#c8d0e0;font-family:'Oswald';font-weight:700;letter-spacing:1.5px;text-transform:uppercase;}
.sb-cal-hint{font-size:0.55rem;color:#82b4ff;font-family:'Oswald';font-weight:700;letter-spacing:1.5px;text-transform:uppercase;text-align:center;padding:4px 0 6px;opacity:0.9;}
.sb-cal-cancel{margin-top:8px;width:100%;padding:6px;background:linear-gradient(140deg,rgba(255,120,120,0.18),rgba(239,83,80,0.06));color:#ff9b9b;border:1px solid rgba(239,83,80,0.3);border-radius:999px;font-family:'Oswald';font-size:0.58rem;letter-spacing:1px;cursor:pointer;font-weight:700;transition:all 0.2s var(--ease);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:inset 0 1px 0 rgba(255,255,255,0.15);}
.sb-cal-cancel:hover{background:linear-gradient(140deg,rgba(255,120,120,0.3),rgba(239,83,80,0.12));transform:translateY(-1px);box-shadow:0 6px 16px rgba(239,83,80,0.25), inset 0 1px 0 rgba(255,255,255,0.2);}
.sb-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:0.62rem;}
.sb-cal-dow{color:#5a6378;font-family:'Oswald';font-weight:700;padding:2px 0 4px;font-size:0.58rem;letter-spacing:0.5px;}
.sb-cal-d{padding:5px 0;color:#8591a8;border-radius:8px;cursor:pointer;transition:all 0.15s var(--ease);font-weight:500;position:relative;}
.sb-cal-d:hover{background:rgba(255,255,255,0.06);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,0.14);}
.sb-cal-d.today{color:#82b4ff;font-weight:700;background:rgba(96,165,250,0.12);box-shadow:inset 0 1px 0 rgba(255,255,255,0.1), 0 0 0 1px rgba(96,165,250,0.25);}
.sb-cal-d.sel{background:linear-gradient(140deg,rgba(96,165,250,0.45),rgba(59,130,246,0.25));color:#fff;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,0.28), 0 0 0 1px rgba(96,165,250,0.55), 0 6px 14px rgba(59,130,246,0.35);}
.sb-cal-d.in-range{background:rgba(96,165,250,0.1);color:#dfe6f2;}

/* Search */
.sb-search{padding:14px 16px 10px;}
.sb-search input{width:100%;padding:10px 14px;background:var(--glass-fill);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);border:var(--glass-border-soft);border-radius:999px;color:#e8ecf4;font-size:0.8rem;font-family:'Inter';outline:none;transition:all 0.2s var(--ease);box-shadow:inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.2);}
.sb-search input:focus{border-color:rgba(96,165,250,0.55);box-shadow:inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 3px rgba(96,165,250,0.15), 0 6px 18px rgba(59,130,246,0.25);}
.sb-search input::placeholder{color:#5a6378;}

/* Nav */
.sb-nav{padding:6px 10px 20px;flex:1;}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;color:#9aadc7;font-size:0.78rem;font-weight:600;letter-spacing:1px;font-family:'Oswald';transition:all 0.2s var(--ease);margin-bottom:4px;border:1px solid transparent;}
.nav-item:hover{background:var(--glass-fill);color:#fff;border-color:rgba(255,255,255,0.1);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,0.15), 0 6px 14px rgba(0,0,0,0.25);transform:translateX(2px);}
.nav-item.active{background:linear-gradient(140deg,rgba(96,165,250,0.35),rgba(59,130,246,0.1));color:#fff;border-color:rgba(96,165,250,0.4);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,0.25), 0 8px 22px rgba(59,130,246,0.3);}
.nav-ico{font-size:1rem;}

.nav-group{margin-top:10px;}
.nav-group-header{display:flex;align-items:center;gap:8px;padding:8px 14px;color:#6a7488;font-size:0.65rem;font-weight:700;letter-spacing:1.5px;font-family:'Oswald';cursor:pointer;user-select:none;transition:color 0.15s var(--ease);}
.nav-group-header:hover{color:#a9c3e8;}
.ng-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;box-shadow:0 0 8px currentColor, inset 0 1px 0 rgba(255,255,255,0.3);}
.ng-label{flex:1;text-transform:uppercase;}
.ng-count{background:var(--glass-fill);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.08);color:#a9b7cc;padding:2px 8px;border-radius:999px;font-size:0.6rem;box-shadow:inset 0 1px 0 rgba(255,255,255,0.12);}
.ng-arrow{font-size:0.6rem;transition:transform 0.2s var(--ease);}
.nav-group-items{display:flex;flex-direction:column;gap:2px;}

.person-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;font-size:0.78rem;color:#9aadc7;transition:all 0.2s var(--ease);border:1px solid transparent;}
.person-item:hover{background:var(--glass-fill);color:#fff;border-color:rgba(255,255,255,0.1);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,0.14), 0 4px 12px rgba(0,0,0,0.25);transform:translateX(2px);}
.person-item.active{background:linear-gradient(140deg,rgba(96,165,250,0.3),rgba(59,130,246,0.08));color:#fff;border-color:rgba(96,165,250,0.35);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,0.22), 0 6px 18px rgba(59,130,246,0.28);}
.pi-avatar{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Oswald';font-weight:700;color:#0a0b10;font-size:0.78rem;flex-shrink:0;box-shadow:inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.3);}
.pi-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;}
.pi-hrs{font-size:0.65rem;color:#6a7488;font-weight:600;font-family:'Oswald';letter-spacing:0.5px;flex-shrink:0;}
.person-item.active .pi-hrs{color:#82b4ff;}

/* Main topbar */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;border-bottom:1px solid rgba(255,255,255,0.06);background:linear-gradient(180deg,rgba(10,14,28,0.55),rgba(10,14,28,0.32));backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);position:sticky;top:0;z-index:5;gap:14px;flex-wrap:wrap;box-shadow:0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 32px rgba(0,0,0,0.3);}
.topbar-left{display:flex;align-items:center;gap:14px;min-width:0;flex:1;}
.tb-back,.tb-nav-arrow,.tb-period-lbl{background:var(--glass-fill);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);border:var(--glass-border);box-shadow:inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 14px rgba(0,0,0,0.3);transition:all 0.25s var(--ease);}
.tb-back{padding:8px 16px;border-radius:999px;color:#bcd0ea;font-size:0.72rem;font-weight:700;font-family:'Oswald';letter-spacing:1.2px;}
.tb-back:hover{color:#fff;transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 26px rgba(59,130,246,0.3);border-color:rgba(96,165,250,0.45);}
.tb-crumbs{display:flex;align-items:center;gap:8px;font-size:0.72rem;color:#5b7fa6;font-family:'Oswald';letter-spacing:1.5px;}
.tb-crumbs .sep{color:#2a3548;}
.tb-crumbs .current{color:#e8ecf4;}
.topbar-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.tb-nav-arrow{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:999px;color:#bcd0ea;font-size:0.9rem;font-weight:700;}
.tb-nav-arrow:hover{color:#fff;transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 26px rgba(59,130,246,0.3);border-color:rgba(96,165,250,0.45);}
.tb-period-lbl{padding:8px 18px;border-radius:999px;color:#dfe6f2;font-size:0.82rem;font-weight:600;min-width:150px;text-align:center;font-family:'Oswald';letter-spacing:0.8px;}

/* Content area */
.content{padding:24px 32px;max-width:1400px;}

/* Hero block — liquid glass */
.hero{display:flex;align-items:center;gap:20px;padding:26px 30px;background:var(--glass-fill-strong);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);border:var(--glass-border);border-radius:24px;margin-bottom:26px;position:relative;overflow:hidden;box-shadow:var(--glass-shadow);}
.hero::before{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,0.18) 0%,rgba(255,255,255,0.05) 12%,transparent 35%);pointer-events:none;mix-blend-mode:screen;}
.hero::after{content:'';position:absolute;top:-40%;right:-10%;width:460px;height:460px;background:radial-gradient(circle,rgba(96,165,250,0.28) 0%,transparent 65%);pointer-events:none;filter:blur(12px);}
.hero-avatar{width:64px;height:64px;border-radius:18px;display:flex;align-items:center;justify-content:center;font-family:'Oswald';font-weight:800;font-size:1.7rem;color:#0a0b10;flex-shrink:0;position:relative;z-index:1;box-shadow:inset 0 1px 0 rgba(255,255,255,0.35), 0 10px 26px rgba(0,0,0,0.35);}
.hero-info{flex:1;min-width:0;position:relative;z-index:1;}
.hero-eyebrow{font-size:0.66rem;color:#8fb4e4;font-weight:700;letter-spacing:2.5px;font-family:'Oswald';margin-bottom:4px;}
.hero-name{font-family:'Oswald';font-size:1.95rem;font-weight:700;color:#fff;letter-spacing:0.5px;line-height:1.1;}
.hero-meta{font-size:0.82rem;color:#a7b4c8;margin-top:6px;font-weight:500;}
.hero-progress{position:relative;z-index:1;}

/* Section header (DAY/WEEK/MONTH) */
.section-head{display:flex;align-items:center;gap:14px;margin:30px 0 16px;padding:0 4px;flex-wrap:wrap;}
.section-head:first-of-type{margin-top:18px;}
.sh-eyebrow{font-family:'Oswald';font-weight:700;font-size:0.74rem;letter-spacing:3px;color:#8fb4e4;padding:6px 14px;background:var(--glass-fill);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);border:var(--glass-border);border-radius:999px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.22), 0 4px 14px rgba(0,0,0,0.25);}
.sh-title{font-family:'Oswald';font-size:1.2rem;font-weight:700;color:#f2f5fb;letter-spacing:1px;}
.hp-circle{width:90px;height:90px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:6px;box-shadow:0 10px 30px rgba(0,0,0,0.35);}
.hp-inner{width:100%;height:100%;background:linear-gradient(180deg,rgba(10,14,28,0.6),rgba(4,7,16,0.75));border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(16px);box-shadow:inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -12px 24px rgba(0,0,0,0.4);}
.hp-val{font-family:'Oswald';font-size:1.35rem;font-weight:700;color:#fff;}
.hp-lbl{font-size:0.55rem;color:#6b7585;letter-spacing:1.5px;font-weight:700;font-family:'Oswald';margin-top:2px;}

/* KPI grid — liquid glass cards */
.kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-bottom:22px;}
.kpi-card{background:var(--glass-fill);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);border:var(--glass-border);border-radius:22px;padding:22px;position:relative;overflow:hidden;transition:all 0.3s var(--ease);box-shadow:var(--glass-shadow);}
.kpi-card::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.22) 0%,rgba(255,255,255,0.04) 14%,transparent 32%);mix-blend-mode:screen;opacity:0.95;}
.kpi-card:hover{transform:translateY(-3px);border-color:rgba(255,255,255,0.24);box-shadow:var(--glass-shadow-lift);}
.kpi-card::before{content:'';position:absolute;top:-30%;right:-20%;width:160px;height:160px;border-radius:50%;opacity:0.22;pointer-events:none;filter:blur(6px);}
.kpi-hours::before{background:#4caf50;}
.kpi-morning::before{background:#ffa726;}
.kpi-afternoon::before{background:#42a5f5;}
.kpi-night::before{background:#7c4dff;}
.kpi-rip::before{background:#ef5350;}
.kpi-vacation::before{background:#26c6da;}
.kpi-ico{font-size:1.25rem;margin-bottom:10px;opacity:0.85;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.35));position:relative;z-index:1;}
.kpi-val{font-family:'Oswald';font-size:2.15rem;font-weight:700;color:#fff;line-height:1;letter-spacing:0.5px;position:relative;z-index:1;text-shadow:0 2px 10px rgba(0,0,0,0.3);}
.kpi-unit{font-size:1rem;color:#7a8fa8;margin-left:2px;}
.kpi-lbl{font-size:0.72rem;font-weight:700;color:#a7b4c8;letter-spacing:1.5px;text-transform:uppercase;margin-top:8px;position:relative;z-index:1;}
.kpi-sub{font-size:0.65rem;color:#6b7585;margin-top:4px;font-weight:500;position:relative;z-index:1;}
.kpi-hours .kpi-val{color:#5cd37b;}
.kpi-morning .kpi-val{color:#ffb84d;}
.kpi-afternoon .kpi-val{color:#5eb8ff;}
.kpi-night .kpi-val{color:#9a7aff;}
.kpi-rip .kpi-val{color:#ff6b6b;}
.kpi-vacation .kpi-val{color:#4ad8e6;}

/* Panel — liquid glass */
.panel{background:var(--glass-fill);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);border:var(--glass-border);border-radius:22px;margin-bottom:18px;overflow:hidden;box-shadow:var(--glass-shadow);position:relative;}
.panel::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.16) 0%,rgba(255,255,255,0.03) 10%,transparent 28%);mix-blend-mode:screen;opacity:0.9;}
.panel-header{padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;position:relative;z-index:1;}
.panel-title{font-family:'Oswald';font-weight:700;font-size:0.88rem;color:#f2f5fb;letter-spacing:2px;}
.panel-sub{font-size:0.72rem;color:#6b7585;font-weight:500;}

.two-col{display:grid;grid-template-columns:2fr 1fr;gap:18px;margin-bottom:18px;}
.two-col .panel{margin-bottom:0;}

.chart-wrap{padding:16px 20px 10px;position:relative;z-index:1;}

/* Donut */
.donut-wrap{padding:22px;display:flex;align-items:center;gap:22px;position:relative;z-index:1;}
.donut-legend{flex:1;display:flex;flex-direction:column;gap:9px;}
.dl-item{display:flex;align-items:center;gap:10px;font-size:0.78rem;color:#a7b4c8;font-weight:500;}
.dl-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;box-shadow:0 0 8px currentColor;}
.dl-val{margin-left:auto;font-family:'Oswald';color:#e8ecf4;font-weight:700;font-size:0.9rem;}

/* Team list (overview) */
.team-list{padding:10px 14px 14px;position:relative;z-index:1;}
.team-row{display:grid;grid-template-columns:32px 1fr 2fr auto auto auto;align-items:center;gap:12px;padding:12px 12px;border-radius:14px;transition:all 0.22s var(--ease);color:#dfe6f2;border:1px solid transparent;}
.team-row:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.12);box-shadow:inset 0 1px 0 rgba(255,255,255,0.15), 0 6px 18px rgba(0,0,0,0.25);transform:translateY(-1px);}
.tr-avatar{width:30px;height:30px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:'Oswald';font-weight:700;color:#0a0b10;font-size:0.85rem;box-shadow:inset 0 1px 0 rgba(255,255,255,0.35), 0 4px 10px rgba(0,0,0,0.3);}
.tr-name{font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tr-bar-wrap{height:8px;background:rgba(255,255,255,0.05);border-radius:999px;overflow:hidden;min-width:80px;box-shadow:inset 0 1px 2px rgba(0,0,0,0.4);}
.tr-bar{height:100%;border-radius:999px;transition:width 0.5s var(--ease);box-shadow:inset 0 1px 0 rgba(255,255,255,0.35);}
.tr-hours{font-family:'Oswald';font-weight:700;font-size:0.88rem;color:#fff;min-width:55px;text-align:right;}
.tr-target{font-size:0.7rem;color:#6b7585;font-weight:600;min-width:40px;text-align:right;}
.tr-counts{font-size:0.74rem;color:#a7b4c8;font-weight:600;letter-spacing:0.5px;min-width:110px;text-align:right;}

/* Shifts list */
.shifts-list{padding:10px 22px 18px;position:relative;z-index:1;}
.shift-item{display:grid;grid-template-columns:60px 1fr auto;align-items:center;gap:14px;padding:13px 10px;border-bottom:1px solid rgba(255,255,255,0.05);}
.shift-item:last-child{border-bottom:none;}
.shift-date{text-align:center;}
.sd-day{font-size:0.62rem;color:#6b7585;letter-spacing:1.2px;font-weight:700;font-family:'Oswald';text-transform:uppercase;}
.sd-num{font-family:'Oswald';font-size:1.05rem;font-weight:700;color:#e8ecf4;margin-top:2px;}
.shift-body{min-width:0;}
.shift-prod{font-weight:600;font-size:0.88rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.shift-time{font-size:0.74rem;color:#7a8fa8;margin-top:3px;font-family:'Oswald';letter-spacing:0.5px;font-weight:600;}
.shift-type{font-size:0.6rem;font-weight:700;letter-spacing:1px;padding:5px 12px;border-radius:999px;font-family:'Oswald';backdrop-filter:blur(8px);box-shadow:inset 0 1px 0 rgba(255,255,255,0.18);}

/* Mobile */
.mobile-burger{display:none;width:40px;height:40px;align-items:center;justify-content:center;background:var(--glass-fill);backdrop-filter:var(--glass-blur-soft);-webkit-backdrop-filter:var(--glass-blur-soft);border:var(--glass-border);border-radius:12px;color:#dfe6f2;cursor:pointer;transition:all 0.2s var(--ease);box-shadow:inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 16px rgba(0,0,0,0.35);}
.mobile-burger:hover{color:#fff;transform:translateY(-1px);border-color:rgba(96,165,250,0.45);box-shadow:inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 22px rgba(59,130,246,0.3);}
@media(max-width:1024px){
    .kpi-grid{grid-template-columns:repeat(3,1fr);}
    .kpi-card:nth-child(n+4){grid-column:span 1;}
    .two-col{grid-template-columns:1fr;}
    .team-row{grid-template-columns:28px 1fr auto auto;gap:8px;}
    .tr-bar-wrap{display:none;}
    .tr-target,.tr-counts{font-size:0.68rem;}
}
@media(max-width:768px){
    .sidebar{transform:translateX(-100%);transition:transform 0.25s;width:260px;}
    .sidebar.open{transform:translateX(0);box-shadow:0 0 40px rgba(0,0,0,0.6);}
    .main{margin-left:0;}
    .mobile-burger{display:flex;}
    .topbar{padding:12px 14px;}
    .content{padding:16px;}
    .hero{padding:18px;gap:14px;}
    .hero-avatar{width:48px;height:48px;font-size:1.4rem;border-radius:12px;}
    .hero-name{font-size:1.3rem;}
    .hero-progress{display:none;}
    .kpi-grid{grid-template-columns:repeat(2,1fr);gap:10px;}
    .kpi-card{padding:14px;}
    .kpi-val{font-size:1.6rem;}
    .team-row{grid-template-columns:28px 1fr auto;}
    .tr-target,.tr-counts{display:none;}
    .shift-item{grid-template-columns:50px 1fr auto;gap:10px;padding:10px 6px;}
    .sd-num{font-size:0.85rem;}
    .shift-type{font-size:0.55rem;padding:3px 7px;}
}
@media(max-width:480px){
    .kpi-grid{grid-template-columns:1fr 1fr;}
    .topbar-left .tb-crumbs{display:none;}
}

/* Sidebar backdrop on mobile */
.sb-backdrop{display:none;position:fixed;inset:0;background:rgba(4,6,12,0.55);backdrop-filter:blur(10px) saturate(130%);-webkit-backdrop-filter:blur(10px) saturate(130%);z-index:9;}
.sb-backdrop.show{display:block;}
</style>
</head>
<body>
<div class="shell">
    <aside class="sidebar" id="sidebar">
        <div class="sb-brand">
            <img src="/images/icon-192.png" alt="Drachir" class="sb-logo-img" onerror="this.style.display='none';">
            <div>
                <div class="sb-title">DRACHIR</div>
                <div class="sb-sub">Statistics</div>
            </div>
        </div>
        <div class="sb-search">
            <input type="text" id="personSearch" placeholder="Search person..." oninput="filterPeople(this.value)">
        </div>
        <div class="sb-cal" id="miniCal"></div>
        <nav class="sb-nav" id="sbNav">
            ${sidebarHTML}
        </nav>
    </aside>
    <div class="sb-backdrop" id="sbBackdrop" onclick="closeSidebar()"></div>
    <main class="main">
        <div class="topbar">
            <div class="topbar-left">
                <button class="mobile-burger" onclick="openSidebar()">&#9776;</button>
                <a href="/dashboard" class="tb-back">&larr; DASHBOARD</a>
                <div class="tb-crumbs">
                    <span>STATS</span>
                    <span class="sep">/</span>
                    <span class="current">${selectedPerson ? selectedPerson.replace(/"/g, '') : 'OVERVIEW'}</span>
                </div>
            </div>
            <div class="topbar-right">
                <a href="/stats?${selectedPerson ? 'person=' + encodeURIComponent(selectedPerson) + '&' : ''}date=${prevDate}" class="tb-nav-arrow" title="Previous day">&larr;</a>
                <span class="tb-period-lbl">${dayLabel}</span>
                <a href="/stats?${selectedPerson ? 'person=' + encodeURIComponent(selectedPerson) + '&' : ''}date=${nextDate}" class="tb-nav-arrow" title="Next day">&rarr;</a>
            </div>
        </div>
        <div class="content">
            ${mainHTML}
        </div>
    </main>
</div>

<script>
var _statsAnchor=${JSON.stringify(toISOLocal(anchorDate))};
var _statsWeekStart=${JSON.stringify(toISOLocal(weekStart))};
var _statsWeekEnd=${JSON.stringify(toISOLocal(weekEnd))};
var _statsPerson=${JSON.stringify(selectedPerson || '')};
var _calYear=new Date(_statsAnchor+'T12:00:00').getFullYear();
var _calMonth=new Date(_statsAnchor+'T12:00:00').getMonth();

function _toISO(y,m,d){return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');}

function buildMiniCal(){
    var el=document.getElementById('miniCal');
    if(!el)return;
    var mNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
    var today=new Date(); today.setHours(0,0,0,0);
    var anchor=new Date(_statsAnchor+'T00:00:00');
    var wStart=new Date(_statsWeekStart+'T00:00:00');
    var wEnd=new Date(_statsWeekEnd+'T00:00:00');
    var h='<div class="sb-cal-nav"><button type="button" onclick="navCal(-1)">&#9664;</button><span>'+mNames[_calMonth]+' '+_calYear+'</span><button type="button" onclick="navCal(1)">&#9654;</button></div>';
    h+='<div class="sb-cal-hint">CLICK A DAY TO PICK</div>';
    h+='<div class="sb-cal-grid">';
    ['M','T','W','T','F','S','S'].forEach(function(d){h+='<div class="sb-cal-dow">'+d+'</div>';});
    var first=new Date(_calYear,_calMonth,1).getDay()||7;
    for(var i=1;i<first;i++) h+='<div></div>';
    var dim=new Date(_calYear,_calMonth+1,0).getDate();
    for(var d=1;d<=dim;d++){
        var cd=new Date(_calYear,_calMonth,d);
        var iso=_toISO(_calYear,_calMonth,d);
        var cls='sb-cal-d';
        if(cd.getTime()===today.getTime()) cls+=' today';
        if(cd>=wStart && cd<=wEnd) cls+=' in-range';
        if(cd.getTime()===anchor.getTime()) cls+=' sel';
        h+='<div class="'+cls+'" onclick="pickCalDate(\\''+iso+'\\')">'+d+'</div>';
    }
    h+='</div>';
    el.innerHTML=h;
}
function navCal(d){
    _calMonth+=d;
    if(_calMonth>11){_calMonth=0;_calYear++;}
    if(_calMonth<0){_calMonth=11;_calYear--;}
    buildMiniCal();
}
function pickCalDate(iso){
    var u=new URL(location);
    u.searchParams.set('date',iso);
    u.searchParams.delete('from'); u.searchParams.delete('to'); u.searchParams.delete('period');
    location.href=u;
}
buildMiniCal();
function toggleNavGroup(gid){
    var el=document.getElementById('grp_'+gid);
    var arr=document.getElementById('arr_'+gid);
    if(!el)return;
    var hidden=el.style.display==='none';
    el.style.display=hidden?'flex':'none';
    if(arr)arr.style.transform=hidden?'rotate(0deg)':'rotate(-90deg)';
}
function openSidebar(){
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sbBackdrop').classList.add('show');
}
function closeSidebar(){
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sbBackdrop').classList.remove('show');
}
function filterPeople(q){
    q=q.toLowerCase().trim();
    var items=document.querySelectorAll('.person-item');
    items.forEach(function(it){
        var n=it.querySelector('.pi-name');
        if(!n)return;
        it.style.display=n.textContent.toLowerCase().includes(q)?'':'none';
    });
}
</script>
</body>
</html>`);

    } catch(err) {
        console.error('Stats error:', err);
        res.status(500).send('Error loading stats: ' + err.message);
    }
});

// --- DASHBOARD ---

app.get('/dashboard', async (req, res) => {
    if (!req.user) return res.redirect('/');

    let hHTML = ""; let rHTML = ""; let pRowsHTML = ""; let mainContentHTML = "";
    let allShifts = [];

    function getProductColor(tradingName, productName) {
        if (productName && productColors[productName]) return productColors[productName];
        const t = tradingHierarchy.find(x => x.name === tradingName);
        return t ? t.color : '#555';
    }

    const allNames = peopleHierarchy.flatMap(g => g.members);
    // BOD 7: target hodin podle skupiny
    const targetHours = {};
    peopleHierarchy.forEach(g => g.members.forEach(n => targetHours[n] = g.target));
    const nowS = new Date();
    const todayStr = toISOLocal(nowS);
    const yesterdayDate = new Date(nowS); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = toISOLocal(yesterdayDate);
    const activeWarriors = new Set();

    try {
        const queryDate = req.query.date ? new Date(req.query.date) : new Date();
        const view = req.query.view || 'timeline';
        const forceSync = req.query.sync === '1';

        const startOfWeek = new Date(queryDate);
        const dayIdx = startOfWeek.getDay() || 7;
        startOfWeek.setHours(0,0,0,0);
        startOfWeek.setDate(startOfWeek.getDate() - (dayIdx - 1));
        const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(endOfWeek.getDate() + 6);
        endOfWeek.setHours(23,59,59,999);

        allShifts = await loadAllShifts(forceSync);
        console.log('Nacteno smen celkem:', allShifts.length);

        // Live coverage tohoto tydne (reuse Faze 6B buildCoverage) -> chip v topbaru, aktualizuje se pres SSE
        const _covDates = [];
        for (let _i = 0; _i < 7; _i++) { const _dd = new Date(startOfWeek); _dd.setDate(startOfWeek.getDate() + _i); _covDates.push(toISOLocal(_dd)); }
        const _covSet = new Set(_covDates);
        const _covProfiles = productMapping.map(p => { const c = getCoverageProfile(p.name); return { name: p.name, slots: c.slots, days: c.days }; });
        const weekCov = buildCoverage(allShifts.filter(s => _covSet.has(s.Date)), _covProfiles, _covDates);
        const _covGaps = weekCov.totalExpected - weekCov.totalCovered;
        const _covColor = weekCov.pct >= 95 ? '#4caf50' : (weekCov.pct >= 80 ? '#a78bfa' : '#e05260');
        const _covWorst = weekCov.products.filter(p => p.gaps > 0).slice(0, 6).map(p => p.product + ' ' + p.pct + '%').join(', ');
        const _covTitle = _covGaps === 0 ? 'This week is fully covered' : ('Not covered this week (' + _covGaps + ' slots). Worst: ' + _covWorst);

        // 3. STATISTIKY A AKTIVNÍ PUNTÍK
        const weekStats = {}; allNames.forEach(n => weekStats[n] = 0);
        const currentTimePercent = timeToPercent(nowS.getHours() + ':' + nowS.getMinutes());

        const _offProducts = new Set(['RIP','Vacation']);
        allShifts.forEach(s => {
            const d = new Date(s.Date);
            if(d >= startOfWeek && d <= endOfWeek) {
                if(weekStats[s.Name] !== undefined && s.Product !== 'RIP' && s.Product !== 'Vacation') weekStats[s.Name] += calculateDuration(s.Start, s.End);
            }
            if(_offProducts.has(s.Product)) return; // RIP/Vacation = no green dot
            if(s.Date === todayStr) {
                const sStart = timeToPercent(s.Start);
                const sEnd = timeToPercent(s.End);
                if (sStart > sEnd) {
                    if (currentTimePercent >= sStart || currentTimePercent <= sEnd) activeWarriors.add(s.Name);
                } else {
                    if (currentTimePercent >= sStart && currentTimePercent <= sEnd) activeWarriors.add(s.Name);
                }
            }
            // Nocni smena zacala vcera a pokracuje dnes rano (napr. 5.4 23:22 - 6.4 07:38)
            if(s.Date === yesterdayStr) {
                const sStart = timeToPercent(s.Start);
                const sEnd = timeToPercent(s.End);
                if (sStart > sEnd && currentTimePercent <= sEnd) activeWarriors.add(s.Name);
            }
        });

        // Crew mapa: seskupi lidi na stejnem datu+produktu+casu (deduplikovane)
        const crewMap = {};
        allShifts.forEach(s => {
            const key = s.Date + '|' + s.Product + '|' + s.Start + '|' + s.End;
            if (!crewMap[key]) crewMap[key] = [];
            if (!crewMap[key].includes(s.Name)) crewMap[key].push(s.Name);
        });
        function getCrewmates(s) {
            const key = s.Date + '|' + s.Product + '|' + s.Start + '|' + s.End;
            const all = crewMap[key] || [];
            return all.filter(n => n !== s.Name);
        }

        // BOD 7: Timeline header – 24 hodinových buněk (40px = 1h, tečkovaná půlhodina uprostřed)
        function buildHoursRow() {
            let spans = '';
            for (let h = 0; h < 24; h++) {
                spans += '<span class="hr-cell">' + h.toString().padStart(2, '0') + '<span class="hr-half-mark"></span></span>';
            }
            return spans;
        }

        // Pomocná funkce: bezpečný escape pro onclick atributy
        function safe(str) { return (str || '').replace(/'/g, '').replace(/"/g, ''); }

        // 4. TIMELINE ZOBRAZENÍ
        if (view === 'timeline') {
            const daysArr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            for(let d=0; d<7; d++) {
                const date = new Date(startOfWeek); date.setDate(startOfWeek.getDate() + d);
                const isToday = toISOLocal(date) === todayStr;
                const isWeekend = d >= 5;
                hHTML += '<div class="day-block' + (isToday ? ' today-block' : '') + (isWeekend ? ' weekend-block' : '') + '">'
                       + '<div class="day-label-top' + (isToday ? ' today-label' : '') + '">' + daysArr[d] + ' ' + date.getDate() + '.' + (date.getMonth()+1) + '.</div>'
                       + '<div class="hours-row">' + buildHoursRow() + '</div>'
                       + '</div>';
            }

            // Helper funkce pro pill
            function buildPersonPill(s, name, dStr, dayIdx, left, width, personColor, prodColor, pillPart) {
                const pillBg = 'repeating-linear-gradient(135deg,' + pastel(personColor) + ' 0px,' + pastel(personColor) + ' 40px,' + pastel(prodColor) + ' 40px,' + pastel(prodColor) + ' 80px)';
                const isOff = (s.Product === 'Vacation' || s.Product === 'RIP');
                const crew = isOff ? [] : getCrewmates(s);
                // Shared note: find best note from all shifts in this group
                const groupShifts = allShifts.filter(x => x.Date === s.Date && x.Product === s.Product && x.Start === s.Start && x.End === s.End);
                const sharedNote = groupShifts.map(x => x.Note).filter(n => n && n !== 'Crew' && !n.endsWith('[Crew]'))[0] || s.Note || '';
                const pillH = isOff ? 26 : (crew.length > 0 ? (34 + crew.length * 14) : 34);
                let crewHTML = '';
                if (crew.length > 0) {
                    crewHTML = '<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:1px;">';
                    crew.forEach(c => {
                        const cc = personColors[c] || '#888';
                        crewHTML += '<span style="font-size:0.55rem;padding:1px 5px;border-radius:3px;background:' + cc + '33;color:' + cc + ';border:1px solid ' + cc + '55;white-space:nowrap;">' + c + '</span>';
                    });
                    crewHTML += '</div>';
                }
                return '<div class="shift-pill" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" data-orig-day="' + dayIdx + '" data-pill-part="' + (pillPart||0) + '" data-shift-date="' + s.Date + '" data-person="' + safe(name) + '" data-person-color="' + personColor + '" data-prod-color="' + prodColor + '" data-tooltip-product="' + safe(s.Product) + '" data-tooltip-trading="' + safe(s.Trading) + '" data-tooltip-note="' + safe(sharedNote) + '" data-sid="' + (s._id||'') + '" data-sht="' + (s._sheet||'') + '" data-snm="' + safe(name) + '"'
                     + ' style="left:' + left + '%;width:' + width + '%;top:calc(50% + 8px);transform:translateY(-50%);height:' + pillH + 'px;background:' + pillBg + ';border-right:3px solid ' + prodColor + ';display:flex;flex-direction:column;justify-content:center;padding:0 8px;"'
                     + ' onclick="openViewModal(\'' + safe(name) + '\',\'' + dStr + '\',\'' + s.Start + '\',\'' + s.End + '\',\'' + safe(s.Product) + '\',\'' + safe(sharedNote) + '\',\'' + s.Trading + '\',\'' + personColor + '\',\'' + prodColor + '\',\'' + (s._sheet||'') + '\',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\',event)">'
                     + '<div style="display:flex;align-items:center;white-space:nowrap;">'
                     + '<span class="pill-time" style="font-size:0.78rem;font-weight:700;">' + s.Start + ' - ' + s.End + '</span>'
                     + '<span style="margin:0 5px;opacity:0.5;">|</span>'
                     + '<span style="font-weight:700;">' + s.Product + '</span>'
                     + '<span style="margin:0 5px;opacity:0.5;">-</span>'
                     + '<span style="font-size:0.78rem;opacity:0.9;">' + name + '</span>'
                     + '</div>'
                     + crewHTML
                     + '</div>';
            }

            // Datum den pred zacatkem tydne (pro nocni smeny ktere presly pres puldnoci)
            const prevWeekDay = new Date(startOfWeek); prevWeekDay.setDate(prevWeekDay.getDate() - 1);
            const prevWeekDayStr = toISOLocal(prevWeekDay);
            // Datum den po konci tydne (pro smeny co se v Lima casu posunou na nedeli)
            const nextWeekDay = new Date(startOfWeek); nextWeekDay.setDate(nextWeekDay.getDate() + 7);
            const nextWeekDayStr = toISOLocal(nextWeekDay);

            peopleHierarchy.forEach(group => {
                group.members.forEach(name => {
                    const personColor = personColors[name] || group.color;
                    let sHTML = "";

                    // Pre-pass: nocni smeny ze dne pred timto tydnem, ktere pokracuji do pondeli
                    allShifts.filter(s => s.Name === name && s.Date === prevWeekDayStr).forEach(s => {
                        const sp = timeToPercent(s.Start), ep = timeToPercent(s.End);
                        if (sp > ep && ep > 0) {
                            const pc2 = getProductColor(s.Trading, s.Product);
                            sHTML += buildPersonPill(s, name, toISOLocal(startOfWeek), 0, 0, ep / 7, personColor, pc2, 2);
                        }
                    });

                    for(let d=0; d<7; d++) {
                        const date = new Date(startOfWeek); date.setDate(startOfWeek.getDate() + d);
                        const dStr = toISOLocal(date);
                        const personShifts = allShifts.filter(s => s.Name === name && s.Date === dStr);
                        personShifts.forEach(s => {
                            const startPct = timeToPercent(s.Start);
                            const endPct   = timeToPercent(s.End);
                            const effEndPct = (endPct === 0 && startPct > 0) ? 100 : endPct;
                            const isOvernight = startPct > effEndPct && effEndPct > 0;
                            const prodColor = getProductColor(s.Trading, s.Product);

                            // Pill 1: od startu do konce dne (nebo do pulnoci pri overnight)
                            const left  = (d * 100 / 7) + (startPct / 7);
                            const width = isOvernight ? (100 - startPct) / 7 : (effEndPct - startPct) / 7;
                            sHTML += buildPersonPill(s, name, dStr, d, left, width, personColor, prodColor, isOvernight ? 1 : 0);

                            // Pill 2: pokracovani overnight v nasledujicim dni
                            if (isOvernight && d < 6) {
                                const nextDate = new Date(startOfWeek); nextDate.setDate(startOfWeek.getDate() + d + 1);
                                const nextDStr = toISOLocal(nextDate);
                                sHTML += buildPersonPill(s, name, nextDStr, d + 1, (d + 1) * 100 / 7, endPct / 7, personColor, prodColor, 2);
                            }
                        });
                    }

                    // Post-pass: shifts from next Monday that in Lima time start on Sunday (hidden, shown by tz toggle)
                    allShifts.filter(s => s.Name === name && s.Date === nextWeekDayStr).forEach(s => {
                        const startH = parseInt(s.Start.split(':')[0]);
                        // Only shifts starting before 06:00 CET can appear on Sunday in Lima (-6h)
                        if (startH < 6) {
                            const prodColor = getProductColor(s.Trading, s.Product);
                            // Render as hidden pill on day 7 (beyond visible week) — tz toggle will shift to day 6
                            const sp = timeToPercent(s.Start);
                            const ep = timeToPercent(s.End);
                            const left = (7 * 100 / 7) + (sp / 7);
                            const width = (ep - sp) / 7;
                            const pill = buildPersonPill(s, name, nextWeekDayStr, 7, left, width, personColor, prodColor, 0);
                            sHTML += pill.replace('style="', 'style="visibility:hidden;');
                        }
                    });

                    rHTML += '<div class="timeline-row hidden-row user-row" data-name="' + name + '">'
                           + '<div class="row-grid-bg">'
                           + '<div class="row-label" style="position:sticky;left:10px;top:3px;font-size:0.66rem;color:#aab6cf;font-weight:600;z-index:20;pointer-events:none;text-shadow:0 1px 2px rgba(10,13,20,0.55);">'
                           + group.label + ' &gt; <span style="color:' + personColor + ';">' + name + '</span>'
                           + '</div>' + sHTML + '</div></div>';
                });
            });

            tradingHierarchy.forEach(trading => {
                trading.subs.forEach(pName => {
                    let psHTML = "";
                    const renderedProdKeys = new Set();

                    // Helper pro pill produktoveho radku
                    function buildProdPill(s, pName, dStr, dayIdx, left, width, personColor, prodColor, pillPart) {
                        const isOff = (pName === 'Vacation' || pName === 'RIP');
                        const crew = isOff ? [] : getCrewmates(s);
                        const allOnShift = isOff ? [s.Name] : [s.Name, ...crew];
                        // Collect best note from all shifts in this group
                        const groupShifts = allShifts.filter(x => x.Date === s.Date && x.Product === s.Product && x.Start === s.Start && x.End === s.End);
                        const groupNote = groupShifts.map(x => x.Note).filter(n => n && n !== 'Crew' && !n.endsWith('[Crew]'))[0] || s.Note || '';
                        const allNamesForTitle = groupShifts.map(x => x.Name).filter((v,i,a)=>a.indexOf(v)===i);
                        // Use gradient with product color only (multiple people = product-focused pill)
                        const pillBg = (!isOff && crew.length > 0)
                            ? 'linear-gradient(135deg,' + pastel(prodColor) + ' 0%,' + pastel(prodColor) + ' 100%)'
                            : 'repeating-linear-gradient(135deg,' + pastel(personColor) + ' 0px,' + pastel(personColor) + ' 40px,' + pastel(prodColor) + ' 40px,' + pastel(prodColor) + ' 80px)';
                        const pillH = isOff ? 26 : (34 + (allOnShift.length > 1 ? allOnShift.length * 14 : 0));
                        let namesHTML = '';
                        if (!isOff && allOnShift.length > 1) {
                            namesHTML = '<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:1px;">';
                            allOnShift.forEach(n => {
                                const nc = personColors[n] || '#888';
                                namesHTML += '<span style="font-size:0.55rem;padding:1px 5px;border-radius:3px;background:' + nc + '33;color:' + nc + ';border:1px solid ' + nc + '55;white-space:nowrap;">' + n + '</span>';
                            });
                            namesHTML += '</div>';
                        }
                        return '<div class="shift-pill" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" data-orig-day="' + dayIdx + '" data-pill-part="' + (pillPart||0) + '" data-shift-date="' + s.Date + '" data-person="' + safe(s.Name) + '" data-person-color="' + personColor + '" data-prod-color="' + prodColor + '" data-tooltip-product="' + safe(pName) + '" data-tooltip-trading="' + safe(s.Trading) + '" data-tooltip-note="' + safe(groupNote) + '" data-sid="' + (s._id||'') + '" data-sht="' + (s._sheet||'') + '" data-snm="' + safe(s.Name) + '"'
                             + ' style="left:' + left + '%;width:' + width + '%;top:calc(50% + 8px);transform:translateY(-50%);height:' + pillH + 'px;background:' + pillBg + ';border-right:3px solid ' + prodColor + ';display:flex;flex-direction:column;justify-content:center;padding:0 8px;"'
                             + ' onclick="openViewModal(\'' + safe(s.Name) + '\',\'' + dStr + '\',\'' + s.Start + '\',\'' + s.End + '\',\'' + safe(pName) + '\',\'' + safe(s.Note) + '\',\'' + s.Trading + '\',\'' + personColor + '\',\'' + prodColor + '\',\'' + (s._sheet||'') + '\',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\',event)">'
                             + '<div style="display:flex;align-items:center;white-space:nowrap;">'
                             + '<span class="pill-time" style="font-size:0.78rem;font-weight:700;">' + s.Start + ' - ' + s.End + '</span>'
                             + '<span style="margin:0 5px;opacity:0.5;">|</span>'
                             + (isOff && allNamesForTitle.length > 1
                                 ? '<span style="font-weight:700;">' + allNamesForTitle.length + ' people</span><span style="margin:0 5px;opacity:0.5;">-</span>'
                                 : (allOnShift.length > 1
                                     ? '<span style="font-weight:700;">' + allOnShift.length + ' traders</span><span style="margin:0 5px;opacity:0.5;">-</span>'
                                     : '<span style="font-weight:700;">' + s.Name + '</span><span style="margin:0 5px;opacity:0.5;">-</span>'))
                             + '<span style="font-size:0.78rem;opacity:0.9;">' + pName + '</span>'
                             + '</div>'
                             + namesHTML
                             + '</div>';
                    }

                    // Pre-pass: nocni smeny ze dne pred timto tydnem, ktere pokracuji do pondeli
                    allShifts.filter(s => s.Product === pName && s.Date === prevWeekDayStr).forEach(s => {
                        const preKey = s.Date + '|' + s.Product + '|' + s.Start + '|' + s.End;
                        if (renderedProdKeys.has(preKey)) return;
                        const sp = timeToPercent(s.Start), ep = timeToPercent(s.End);
                        if (sp > ep && ep > 0) {
                            renderedProdKeys.add(preKey);
                            const pc = personColors[s.Name] || '#555';
                            const prc = getProductColor(trading.name, pName);
                            psHTML += buildProdPill(s, pName, toISOLocal(startOfWeek), 0, 0, ep / 7, pc, prc, 2);
                        }
                    });

                    for(let d=0; d<7; d++) {
                        const date = new Date(startOfWeek); date.setDate(startOfWeek.getDate() + d);
                        const dStr = toISOLocal(date);
                        const prodShifts = allShifts.filter(s => s.Product === pName && s.Date === dStr);
                        prodShifts.forEach(s => {
                            // Deduplicate: skip if same product+date+start+end already rendered
                            const prodKey = s.Date + '|' + s.Product + '|' + s.Start + '|' + s.End;
                            if (renderedProdKeys.has(prodKey)) return;
                            renderedProdKeys.add(prodKey);

                            const startPct2 = timeToPercent(s.Start);
                            const endPct2   = timeToPercent(s.End);
                            const effEndPct2 = (endPct2 === 0 && startPct2 > 0) ? 100 : endPct2;
                            const isOvernight2 = startPct2 > effEndPct2 && effEndPct2 > 0;
                            const left = (d * 100 / 7) + (startPct2 / 7);
                            const width = isOvernight2 ? (100 - startPct2) / 7 : (effEndPct2 - startPct2) / 7;
                            const personColor = personColors[s.Name] || '#555';
                            const prodColor = getProductColor(trading.name, pName);

                            // Pill 1: od startu do pulnoci (nebo cely den)
                            psHTML += buildProdPill(s, pName, dStr, d, left, width, personColor, prodColor, isOvernight2 ? 1 : 0);

                            // Pill 2: pokracovani overnight do nasledujiciho dne
                            if (isOvernight2 && d < 6) {
                                const nextDate = new Date(startOfWeek); nextDate.setDate(startOfWeek.getDate() + d + 1);
                                const nextDStr = toISOLocal(nextDate);
                                psHTML += buildProdPill(s, pName, nextDStr, d + 1, (d + 1) * 100 / 7, endPct2 / 7, personColor, prodColor, 2);
                            }
                        });
                    }

                    // Post-pass: shifts from next Monday for Lima tz (hidden, shown by tz toggle)
                    allShifts.filter(s => s.Product === pName && s.Date === nextWeekDayStr).forEach(s => {
                        const prodKey = s.Date + '|' + s.Product + '|' + s.Start + '|' + s.End;
                        if (renderedProdKeys.has(prodKey)) return;
                        const startH = parseInt(s.Start.split(':')[0]);
                        if (startH < 6) {
                            renderedProdKeys.add(prodKey);
                            const personColor = personColors[s.Name] || '#555';
                            const prodColor = getProductColor(trading.name, pName);
                            const sp = timeToPercent(s.Start);
                            const ep = timeToPercent(s.End);
                            const left = (7 * 100 / 7) + (sp / 7);
                            const width = (ep - sp) / 7;
                            const pill = buildProdPill(s, pName, nextWeekDayStr, 7, left, width, personColor, prodColor, 0);
                            psHTML += pill.replace('style="', 'style="visibility:hidden;');
                        }
                    });

                    const pLabelColor = productColors[pName] || trading.color;
                    pRowsHTML += '<div class="timeline-row hidden-row product-row" data-product-row="' + pName + '">'
                               + '<div class="row-grid-bg">'
                               + '<div class="row-label" style="position:sticky;left:10px;top:3px;font-size:0.66rem;color:#aab6cf;font-weight:600;z-index:20;pointer-events:none;text-shadow:0 1px 2px rgba(10,13,20,0.55);">'
                               + 'Product &gt; <span style="color:' + pLabelColor + ';">' + pName + '</span>'
                               + '</div>' + psHTML + '</div></div>';
                });
            });

            mainContentHTML = '<div class="timeline-viewport" id="viewport">'
                            + '<div class="timeline-header" style="position:sticky;top:0;z-index:110;">' + hHTML + '</div>'
                            + '<div class="timeline-rows-container" style="position:relative;">' + rHTML + pRowsHTML + '</div>'
                            + '</div>';
        }
        // WEEK ZOBRAZENÍ
        else if (view === 'week') {
            const daysArr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            let weekHeader = '<div style="width:60px;flex-shrink:0;background:#131826;border-right:1px solid rgba(165,180,252,0.14);border-bottom:1px solid rgba(165,180,252,0.14);z-index:10;"></div>';
            let weekGrid   = '<div style="width:60px;flex-shrink:0;background:#131826;border-right:1px solid rgba(165,180,252,0.14);display:flex;flex-direction:column;">';

            for(let h=0; h<24; h++) {
                weekGrid += '<div style="height:40px;border-bottom:1px solid rgba(165,180,252,0.08);text-align:right;font-size:0.62rem;color:#8a93ab;display:flex;align-items:flex-start;justify-content:flex-end;font-weight:bold;padding:2px 6px 0 0;box-sizing:border-box;position:relative;">'
                          + h.toString().padStart(2,'0') + ':00'
                          + '<div style="position:absolute;left:0;right:0;top:20px;border-top:1px dashed rgba(165,180,252,0.14);"></div>'
                          + '</div>';
            }
            weekGrid += '</div>';

            for(let d=0; d<7; d++) {
                const date = new Date(startOfWeek); date.setDate(startOfWeek.getDate() + d);
                const dStr = toISOLocal(date);
                const isToday = dStr === todayStr;

                const isWeekendW = d >= 5;
                weekHeader += '<div style="flex:1;text-align:center;padding:10px 0;border-right:1px solid rgba(165,180,252,0.14);border-bottom:1px solid rgba(165,180,252,0.14);font-weight:bold;font-size:0.85rem;' + (isToday ? 'background:rgba(167,139,250,0.16);color:#a78bfa;' : isWeekendW ? 'background:rgba(96,165,250,0.09);' : 'background:#131826;') + '">' + daysArr[d] + ' ' + date.getDate() + '.' + (date.getMonth()+1) + '.</div>';

                let dayColumn = '<div style="flex:1;border-right:1px solid rgba(165,180,252,0.14);position:relative;background:' + (isToday ? '#131826' : isWeekendW ? 'rgba(96,165,250,0.06)' : '#131826') + ';min-width:100px;overflow:hidden;">';
                for(let h=0; h<24; h++) {
                    dayColumn += '<div style="height:40px;border-bottom:1px solid rgba(165,180,252,0.08);box-sizing:border-box;position:relative;">'
                               + '<div style="position:absolute;left:0;right:0;top:20px;border-top:1px dashed rgba(165,180,252,0.06);"></div>'
                               + '</div>';
                }

                // Overnight continuation from previous day
                if (d > 0) {
                    const prevDate2 = new Date(startOfWeek); prevDate2.setDate(startOfWeek.getDate() + d - 1);
                    const prevDStr2 = toISOLocal(prevDate2);
                    allShifts.filter(s => s.Date === prevDStr2).forEach(s => {
                        const sp2 = timeToPercent(s.Start), ep2 = timeToPercent(s.End);
                        if (!(sp2 > ep2 && ep2 > 0)) return;
                        const h2 = (ep2 / 100) * (24 * 40);
                        const personColor = personColors[s.Name] || '#555';
                        const prodColor   = getProductColor(s.Trading, s.Product);
                        const overnightBg2 = 'repeating-linear-gradient(135deg,' + pastel(personColor) + ' 0px,' + pastel(personColor) + ' 40px,' + pastel(prodColor) + ' 40px,' + pastel(prodColor) + ' 80px)';
                        dayColumn += '<div class="shift-pill user-row product-row" data-name="' + s.Name + '" data-product-row="' + s.Product + '" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" data-orig-day="' + d + '" data-shift-date="' + s.Date + '" data-person-color="' + personColor + '" data-prod-color="' + prodColor + '" data-tooltip-product="' + safe(s.Product) + '" data-tooltip-trading="' + safe(s.Trading) + '" data-tooltip-note="' + safe(s.Note||'') + '"'
                                   + ' style="position:absolute;top:0px;height:' + h2 + 'px;left:4px;right:4px;background:' + overnightBg2 + ';color:#11151f;border-radius:0 0 4px 4px;padding:0 8px;font-size:0.65rem;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;cursor:pointer;z-index:5;border-right:3px solid ' + prodColor + ';opacity:0.85;white-space:nowrap;"'
                                   + ' onclick="openViewModal(\'' + safe(s.Name) + '\',\'' + prevDStr2 + '\',\'' + s.Start + '\',\'' + s.End + '\',\'' + safe(s.Product) + '\',\'' + safe(s.Note) + '\',\'' + s.Trading + '\',\'' + personColor + '\',\'' + prodColor + '\',\'' + (s._sheet||'') + '\',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\',event)">'
                                   + '<span style="font-weight:700;">' + s.Name + '</span>'
                                   + '<span style="margin:0 5px;opacity:0.5;">|</span>'
                                   + '<span class="tz-time" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" data-product="' + safe(s.Product) + '" style="font-size:0.78rem;opacity:0.9;">' + s.Start + '-' + s.End + ' ' + s.Product + '</span>'
                                   + '</div>';
                    });
                }

                // Regular shifts for this day
                const dayShifts = allShifts.filter(s => s.Date === dStr);
                dayShifts.forEach(s => {
                    const startPct = timeToPercent(s.Start);
                    const endPct   = timeToPercent(s.End);
                    const effEndPct = (endPct === 0 && startPct > 0) ? 100 : endPct;
                    const isOvernight = startPct > effEndPct && effEndPct > 0;
                    const sTop   = (startPct / 100) * (24 * 40);
                    const height = isOvernight ? (1 - startPct / 100) * (24 * 40) : ((effEndPct - startPct) / 100) * (24 * 40);
                    const personColor = personColors[s.Name] || '#555';
                    const prodColor   = getProductColor(s.Trading, s.Product);
                    const weekPillBg = 'repeating-linear-gradient(135deg,' + pastel(personColor) + ' 0px,' + pastel(personColor) + ' 40px,' + pastel(prodColor) + ' 40px,' + pastel(prodColor) + ' 80px)';
                    dayColumn += '<div class="shift-pill user-row product-row" data-name="' + s.Name + '" data-product-row="' + s.Product + '" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" data-orig-day="' + d + '" data-shift-date="' + s.Date + '" data-person-color="' + personColor + '" data-prod-color="' + prodColor + '" data-tooltip-product="' + safe(s.Product) + '" data-tooltip-trading="' + safe(s.Trading) + '" data-tooltip-note="' + safe(s.Note||'') + '"'
                               + ' style="position:absolute;top:' + sTop + 'px;height:' + height + 'px;left:4px;right:4px;background:' + weekPillBg + ';color:#11151f;border-radius:' + (isOvernight ? '4px 4px 0 0' : '4px') + ';padding:0 8px;font-size:0.65rem;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;cursor:pointer;z-index:5;border-right:3px solid ' + prodColor + ';white-space:nowrap;"'
                               + ' onclick="openViewModal(\'' + safe(s.Name) + '\',\'' + dStr + '\',\'' + s.Start + '\',\'' + s.End + '\',\'' + safe(s.Product) + '\',\'' + safe(s.Note) + '\',\'' + s.Trading + '\',\'' + personColor + '\',\'' + prodColor + '\',\'' + (s._sheet||'') + '\',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\',event)">'
                               + '<span style="font-weight:700;">' + s.Name + '</span>'
                               + '<span style="margin:0 5px;opacity:0.5;">|</span>'
                               + '<span class="tz-time" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" data-product="' + safe(s.Product) + '" style="font-size:0.78rem;opacity:0.9;">' + s.Start + '-' + s.End + ' ' + s.Product + '</span>'
                               + '</div>';
                });
                dayColumn += '</div>'; weekGrid += dayColumn;
            }

            mainContentHTML = '<div class="week-wrapper" style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;background:#0f1320;">'
                            + '<div class="week-header-row" style="display:flex;background:#131826;position:sticky;top:0;z-index:10;min-width:760px;">' + weekHeader + '</div>'
                            + '<div class="week-grid-row" style="display:flex;flex-grow:1;overflow-y:auto;position:relative;min-width:760px;" id="weekViewport">' + weekGrid + '</div>'
                            + '</div>';
        }

        // LIST ZOBRAZENÍ
        else if (view === 'list') {
            const daysShortL = ['sun','mon','tue','wed','thu','fri','sat'];
            const fmtD = function(dt) { return dt.getDate().toString().padStart(2,'0') + '.' + (dt.getMonth()+1).toString().padStart(2,'0') + '.' + dt.getFullYear(); };
            function getISOWeek(dt) {
                const tmp = new Date(dt.getTime()); tmp.setDate(tmp.getDate() + 3 - (tmp.getDay() + 6) % 7);
                const w1 = new Date(tmp.getFullYear(), 0, 4);
                return 1 + Math.round(((tmp - w1) / 86400000 - (w1.getDay() + 6) % 7 + 3) / 7);
            }

            // Server renders 5 weeks: 2 before, current, 2 after. Client JS will load more on scroll.
            const listStart = new Date(startOfWeek); listStart.setDate(listStart.getDate() - 14);
            const totalDays = 35;

            let listHTML = '<div class="list-viewport" style="flex-grow:1;overflow-y:auto;background:#0f1320;" id="listViewport">';

            function buildListDay(date, dStr, isToday, dow, isWeekendL, dayShifts, showWeekHeader) {
                let h = '';
                if (showWeekHeader) {
                    const wkStart = new Date(date);
                    if (dow !== 1) { wkStart.setDate(wkStart.getDate() - (dow === 0 ? 6 : dow - 1)); }
                    const wkEnd = new Date(wkStart); wkEnd.setDate(wkStart.getDate() + 6);
                    const wn = getISOWeek(date);
                    const isCurrentWeek = toISOLocal(wkStart) === toISOLocal(startOfWeek);
                    h += '<div class="list-week-header" id="' + (isCurrentWeek ? 'listCurrentWeek' : '') + '" style="display:flex;justify-content:space-between;align-items:center;padding:10px 18px;background:#161b2c;border-bottom:1px solid rgba(165,180,252,0.14);position:sticky;top:0;z-index:5;">'
                       + '<span style="font-size:0.8rem;font-weight:600;color:#aab6cf;">' + fmtD(wkStart) + ' &ndash; ' + fmtD(wkEnd) + '</span>'
                       + '<span style="font-size:0.75rem;font-weight:700;color:#7c87a3;">Week ' + wn + '</span>'
                       + '</div>';
                }
                h += '<div style="display:flex;min-height:58px;border-bottom:1px solid rgba(165,180,252,0.08);' + (isToday ? 'background:rgba(167,139,250,0.12);' : isWeekendL ? 'background:rgba(96,165,250,0.06);' : 'background:#131826;') + '" id="' + (isToday ? 'listToday' : '') + '">';
                h += '<div style="width:52px;flex-shrink:0;padding:12px 0;text-align:center;' + (isToday ? 'border-left:3px solid #a78bfa;' : 'border-left:3px solid transparent;') + '">'
                   + '<div style="font-size:1.5rem;font-weight:700;color:' + (isToday ? '#a78bfa' : isWeekendL ? '#7ba3cc' : '#e8ecf4') + ';line-height:1;">' + date.getDate() + '</div>'
                   + '<div style="font-size:0.6rem;font-weight:600;color:' + (isToday ? '#a78bfa' : isWeekendL ? '#7ba3cc' : '#7c87a3') + ';margin-top:2px;">' + daysShortL[dow] + '</div>'
                   + '</div>';
                h += '<div style="flex:1;padding:8px 12px 8px 8px;">';
                if (dayShifts.length === 0) {
                    h += '<div style="padding:8px 0;font-size:0.78rem;color:#6b768f;font-style:italic;">No events</div>';
                } else {
                    dayShifts.forEach(s => {
                        const personColor = personColors[s.Name] || '#555';
                        const prodColor   = getProductColor(s.Trading, s.Product);
                        const dur = calculateDuration(s.Start, s.End);
                        h += '<div class="user-row product-row" data-name="' + s.Name + '" data-product-row="' + s.Product + '" data-person-color="' + personColor + '" data-prod-color="' + prodColor + '"'
                           + ' style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#161b2c;border-radius:10px;margin-bottom:5px;cursor:pointer;border-left:4px solid ' + prodColor + ';box-shadow:0 1px 3px rgba(0,0,0,0.06);transition:box-shadow 0.15s;"'
                           + ' onmouseover="this.style.boxShadow=\'0 3px 8px rgba(0,0,0,0.12)\'" onmouseout="this.style.boxShadow=\'0 1px 3px rgba(0,0,0,0.06)\'"'
                           + ' onclick="openViewModal(\'' + safe(s.Name) + '\',\'' + dStr + '\',\'' + s.Start + '\',\'' + s.End + '\',\'' + safe(s.Product) + '\',\'' + safe(s.Note) + '\',\'' + s.Trading + '\',\'' + personColor + '\',\'' + prodColor + '\',\'' + (s._sheet||'') + '\',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\',event)">'
                           + '<div style="flex:1;min-width:0;">'
                           + '<div style="font-weight:700;font-size:0.85rem;color:#e8ecf4;display:flex;align-items:center;gap:6px;">'
                           + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + prodColor + ';flex-shrink:0;"></span>'
                           + s.Product + '</div>'
                           + '<div style="font-size:0.72rem;color:#8a93ab;margin-top:3px;">'
                           + '<span class="tz-time" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '">' + s.Start + ' - ' + s.End + '</span>'
                           + ', ' + s.Trading + ' &gt; ' + s.Name
                           + '</div>'
                           + '</div>'
                           + '<div style="text-align:right;flex-shrink:0;color:#7c87a3;font-size:0.68rem;">' + dur.toFixed(1) + 'h</div>'
                           + '</div>';
                    });
                }
                h += '</div></div>';
                return h;
            }

            for (let d = 0; d < totalDays; d++) {
                const date = new Date(listStart); date.setDate(listStart.getDate() + d);
                const dStr = toISOLocal(date);
                const isToday = dStr === todayStr;
                const dow = date.getDay();
                const isWeekendL = dow === 0 || dow === 6;
                const dayShifts = allShifts.filter(s => s.Date === dStr).sort((a, b) => a.Start.localeCompare(b.Start));
                const showWeekHeader = dow === 1 || d === 0;
                listHTML += buildListDay(date, dStr, isToday, dow, isWeekendL, dayShifts, showWeekHeader);
            }
            listHTML += '</div>';

            // Serialize allShifts dates for client-side infinite scroll
            const listShiftsJSON = JSON.stringify(allShifts.map(s => ({D:s.Date,N:s.Name,S:s.Start,E:s.End,P:s.Product,T:s.Trading,No:s.Note||'',_s:s._sheet||'',_r:s._row||0,_c:s._col||0})));

            mainContentHTML = '<div class="list-wrapper" style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;">' + listHTML + '</div>'
                            + '<script>window._listShifts=' + listShiftsJSON + ';window._listStartISO="' + toISOLocal(listStart) + '";window._listDaysRendered=' + totalDays + ';</script>';
        }

        // AGENDA ZOBRAZENÍ
        else if (view === 'agenda') {
            const daysShortArr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            let agendaHTML = '<div style="flex-grow:1;overflow-y:auto;" id="agendaViewport">';
            for (let d = 0; d < 7; d++) {
                const date = new Date(startOfWeek); date.setDate(startOfWeek.getDate() + d);
                const dStr = toISOLocal(date);
                const isToday = dStr === todayStr;
                const isWeekendA = d >= 5;
                const dayShifts = allShifts.filter(s => s.Date === dStr).sort((a, b) => a.Start.localeCompare(b.Start));
                agendaHTML += '<div style="display:flex;min-height:54px;border-bottom:1px solid rgba(165,180,252,0.08);background:' + (isWeekendA && !isToday ? 'rgba(96,165,250,0.05)' : '#131826') + ';" id="' + (isToday ? 'agendaToday' : '') + '">';
                // Date sidebar
                agendaHTML += '<div style="width:68px;flex-shrink:0;padding:12px 8px;text-align:center;background:' + (isToday ? 'rgba(167,139,250,0.16)' : isWeekendA ? 'rgba(96,165,250,0.09)' : '#131826') + ';border-right:1px solid rgba(165,180,252,0.08);position:sticky;left:0;">'
                            + '<div style="font-size:1.5rem;font-weight:700;color:' + (isToday ? '#a78bfa' : isWeekendA ? '#7ba3cc' : '#e8ecf4') + ';line-height:1;">' + date.getDate() + '</div>'
                            + '<div style="font-size:0.65rem;font-weight:600;color:' + (isToday ? '#a78bfa' : isWeekendA ? '#7ba3cc' : '#8a93ab') + ';text-transform:uppercase;letter-spacing:0.5px;">' + daysShortArr[d] + '</div>'
                            + (isToday ? '<div style="width:6px;height:6px;background:#a78bfa;border-radius:50%;margin:4px auto 0;"></div>' : '')
                            + '</div>';
                // Events
                agendaHTML += '<div style="flex:1;padding:8px 14px;">';
                if (dayShifts.length === 0) {
                    agendaHTML += '<div style="padding:14px 0;font-size:0.78rem;color:#6b768f;font-style:italic;">No shifts</div>';
                } else {
                    dayShifts.forEach(s => {
                        const personColor = personColors[s.Name] || '#555';
                        const prodColor   = getProductColor(s.Trading, s.Product);
                        const dur = calculateDuration(s.Start, s.End);
                        agendaHTML += '<div class="user-row product-row" data-name="' + s.Name + '" data-product-row="' + s.Product + '" data-person-color="' + personColor + '" data-prod-color="' + prodColor + '"'
                                    + ' style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:#131826;border-radius:7px;margin-bottom:5px;cursor:pointer;border-left:4px solid ' + prodColor + ';box-shadow:0 1px 4px rgba(0,0,0,0.08);transition:box-shadow 0.15s;"'
                                    + ' onmouseover="this.style.boxShadow=\'0 3px 10px rgba(0,0,0,0.15)\'" onmouseout="this.style.boxShadow=\'0 1px 4px rgba(0,0,0,0.08)\'"'
                                    + ' onclick="openViewModal(\'' + safe(s.Name) + '\',\'' + dStr + '\',\'' + s.Start + '\',\'' + s.End + '\',\'' + safe(s.Product) + '\',\'' + safe(s.Note) + '\',\'' + s.Trading + '\',\'' + personColor + '\',\'' + prodColor + '\',\'' + (s._sheet||'') + '\',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\',event)">'
                                    + '<div style="width:4px;align-self:stretch;background:' + personColor + ';border-radius:2px;flex-shrink:0;min-height:32px;"></div>'
                                    + '<div style="flex:1;min-width:0;">'
                                    + '<div style="font-weight:700;font-size:0.85rem;color:#e8ecf4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + s.Name + '</div>'
                                    + '<div style="font-size:0.74rem;color:#aab6cf;margin-top:1px;">' + s.Product + (s.Note ? ' <span style="color:#6b768f">·</span> ' + s.Note : '') + '</div>'
                                    + '</div>'
                                    + '<div style="text-align:right;flex-shrink:0;">'
                                    + '<div class="tz-time" data-orig-start="' + s.Start + '" data-orig-end="' + s.End + '" style="font-size:0.78rem;font-weight:600;color:#aab6cf;">' + s.Start + ' – ' + s.End + '</div>'
                                    + '<div style="font-size:0.68rem;color:#7c87a3;">' + dur.toFixed(1) + 'h</div>'
                                    + '</div>'
                                    + '</div>';
                    });
                }
                agendaHTML += '</div></div>';
            }
            agendaHTML += '</div>';
            mainContentHTML = '<div style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;background:#0f1320;">' + agendaHTML + '</div>';
        }

        // Serializace dat pro klientský JS
        const personColorsJSON = JSON.stringify(personColors);
        const personRolesJS = peopleHierarchy.map(g =>
            g.members.map(n => 'pRoles["' + n.replace(/"/g, '') + '"]="' + g.label.replace(/"/g, '') + '";').join('')
        ).join('');
        const tradingColorsJS = tradingHierarchy.map(t =>
            'tColors["' + t.name + '"]="' + t.color + '";'
        ).join('');
        const productColorsClientJS = 'const pColorsProduct=' + JSON.stringify(productColors) + ';';

        // --- HTML ŠABLONA ---
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#0d0e14">
    <meta name="csrf-token" content="${req.session.csrf}">
    <script>
    (function(){
      var meta = document.querySelector('meta[name="csrf-token"]');
      var _csrf = meta ? meta.content : '';
      var _origFetch = window.fetch;
      var _lastLocal = 0;
      window.fetch = function(url, opts){
        opts = opts || {};
        var method = (opts.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          _lastLocal = Date.now();   // own change -> suppress self-reload from SSE
          opts.headers = Object.assign({}, opts.headers || {}, { 'X-CSRF-Token': _csrf });
        }
        return _origFetch(url, opts);
      };
      // Real-time: SSE oznameni o zmenach rozvrhu (dorovnani Huginnu)
      if (window.EventSource) {
        var _dirty = false;
        try {
          var es = new EventSource('/events');
          es.addEventListener('changed', function(){
            if (Date.now() - _lastLocal < 6000) return;     // my own edit -> ignore
            if (document.hidden) { _dirty = true; return; } // skryta zalozka -> obnov az pri navratu
            if (window.__swapOpen && typeof window.loadSwapBoard === 'function') { window.loadSwapBoard(); return; } // otevreny swap board -> jen ho obnov
            if (typeof toast === 'function') toast('📡 Schedule updated — refreshing…');
            setTimeout(function(){ if (typeof refreshDashboard === 'function') refreshDashboard(); else location.reload(); }, 1500);
          });
          es.onerror = function(){};   // EventSource se sam reconnectne dle retry:5000
        } catch(e){}
        document.addEventListener('visibilitychange', function(){
          if (!document.hidden && _dirty) { _dirty = false; if (typeof refreshDashboard === 'function') refreshDashboard(); else location.reload(); }
        });
      }
    })();
    </script>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="manifest" href="/manifest.json">
    <link rel="icon" type="image/png" sizes="192x192" href="/images/icon-192.png">
    <link rel="apple-touch-icon" sizes="512x512" href="/images/icon-512.png">
    <title>DRACHIR.GG - Elite Terminal</title>
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600&family=Oswald:wght@700&display=swap" rel="stylesheet">
    <style>
        body{background:#0d0e14;color:#333;margin:0;display:block;overflow:hidden;font-family:'Montserrat',sans-serif;}
        .warp-arrival{position:fixed;inset:0;z-index:9999;pointer-events:none;background:rgba(13,13,13,0.95);animation:warpFadeIn 0.8s ease-out forwards;}
        @keyframes warpFadeIn{0%{opacity:1;}60%{opacity:0.3;}100%{opacity:0;}}

        /* MOBILE VERSION */
        @media (max-width: 768px) {
            .dashboard-container{grid-template-columns:1fr!important;}
            .sidebar{display:none!important;}
            .mobile-menu-btn{display:flex!important;}
            .sidebar.mobile-open{display:flex!important;position:fixed;left:0;top:0;width:280px;height:100vh;z-index:999;box-shadow:4px 0 32px rgba(0,0,0,0.7);}
            /* Topbar — position:fixed, always on top */
            .topbar-main{position:fixed!important;top:0!important;left:0!important;right:0!important;z-index:100!important;padding:8px 10px!important;min-height:44px!important;box-sizing:border-box!important;}
            .main-content{padding-top:44px!important;}
            .topbar-left{gap:6px!important;}
            .topbar-right{gap:4px!important;}
            .topbar-right .month-label{display:none!important;}
            .topbar-right .user-box{display:none!important;}
            .topbar-right .btn-slack{display:none!important;}
            .topbar-right .btn-stats{display:none!important;}
            .topbar-right .btn-current-week{display:none!important;}
            .mobile-user-compact{display:flex!important;}
            /* View toggle - smaller, LIST first on mobile */
            .view-toggle-bar{gap:0px!important;}
            .view-toggle-bar button{padding:5px 7px!important;font-size:0.6rem!important;letter-spacing:0!important;}
            .view-toggle-bar .vt-list{order:-1!important;}
            /* TZ toggle — hide fixed button, show sidebar version */
            .tz-toggle-btn{display:none!important;}
            .sidebar-tz-toggle{display:flex!important;}
            /* Modal full width */
            .modal-outer{margin:0!important;border-radius:0!important;width:100%!important;max-width:100%!important;height:100vh!important;max-height:100vh!important;display:flex;flex-direction:column;}
            .modal-form-section{overflow-y:auto;flex:1;}
            .modal-actions{flex-shrink:0;}
            .modal-info-strip{flex-wrap:wrap;padding:10px 16px!important;gap:12px!important;}
            .modal-header{padding:16px!important;}
            .modal-form-section{padding:14px 16px!important;}
            .modal-actions{padding:14px 16px!important;}
            .modal-tags-row{padding:10px 16px!important;}
            .modal-row2{flex-direction:column!important;gap:0!important;}
            /* Sidebar: hide Color Settings, show Logout */
            .sidebar-color-btn{display:none!important;}
            .sidebar-logout-btn{display:block!important;}
            /* Week view on mobile — horizontal scroll */
            .week-wrapper{overflow-x:auto!important;-webkit-overflow-scrolling:touch;}
            /* List view on mobile */
            .list-viewport{padding:0!important;}
            /* Agenda on mobile */
            #agendaViewport .user-row{gap:6px!important;padding:6px 8px!important;}
        }
        @media (max-width: 480px) {
            .view-toggle-bar button{padding:4px 5px!important;font-size:0.55rem!important;}
            .shift-pill{font-size:0.55rem!important;padding:0 4px!important;}
            .mobile-user-compact span{display:none!important;}
        }
        .mobile-menu-btn{display:none;background:#000;border:1px solid #333;color:#a78bfa;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:1.1rem;align-items:center;}
        .sidebar-logout-btn{display:none;}
        .sidebar-tz-toggle{display:none;}
        .mobile-user-compact{display:none!important;}
        .mobile-overlay{display:none;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:998;}
        .mobile-overlay.show{display:block;}
        .dashboard-container{display:grid;grid-template-columns:280px 1fr;height:100vh;}
        .sidebar{background:#0a0b0f;color:#fff;padding:0;display:flex;flex-direction:column;height:100vh;overflow:hidden;border-right:1px solid #1e2030;box-sizing:border-box;}
        .sidebar-inner{padding:16px 16px 0 16px;display:flex;flex-direction:column;flex:1;overflow:hidden;}
        .sidebar-list{flex:1;overflow-y:auto;padding-right:2px;margin-top:4px;}
        .sidebar-list::-webkit-scrollbar{width:4px;}
        .sidebar-list::-webkit-scrollbar-track{background:#0a0b0f;border-radius:2px;}
        .sidebar-list::-webkit-scrollbar-thumb{background:rgba(167,139,250,0.5);border-radius:2px;}
        .sidebar-list::-webkit-scrollbar-thumb:hover{background:#a78bfa;}
        .sidebar-list{scrollbar-width:thin;scrollbar-color:rgba(167,139,250,0.4) #0a0b0f;}

        /* Logo area */
        .logo-area{display:flex;align-items:center;justify-content:center;padding:18px 0 14px;margin-bottom:4px;gap:10px;border-bottom:1px solid #1e2030;}
        .logo-area img{height:44px;width:auto;filter:drop-shadow(0 0 8px rgba(167,139,250,0.3));}
        .logo-fallback{font-family:'Oswald';font-size:1.25rem;background:linear-gradient(135deg,#a78bfa 0%,#fff8e1 50%,#a78bfa 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-transform:uppercase;letter-spacing:4px;font-weight:700;}

        /* Mini calendar */
        .mini-calendar{background:transparent;border-radius:0;padding:8px 0 12px;margin-bottom:8px;border:none;border-bottom:1px solid #1e2030;}
        .mini-cal-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
        .mini-cal-nav button{background:none;border:none;color:#3a4050;cursor:pointer;font-size:0.9rem;padding:2px 6px;border-radius:4px;transition:0.15s;}
        .mini-cal-nav button:hover{color:#8892a4;}
        .mini-cal-nav span{font-size:0.65rem;background:linear-gradient(90deg,#a78bfa,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;text-transform:uppercase;letter-spacing:2px;}
        .mini-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;text-align:center;font-size:0.6rem;}
        .m-date{padding:3px 1px;border-radius:4px;cursor:pointer;color:#3a4050;transition:0.12s;width:22px;height:22px;display:flex;align-items:center;justify-content:center;margin:1px auto;font-variant-numeric:tabular-nums;}
        .m-date:hover{background:rgba(167,139,250,0.08);color:#a78bfa;}
        .m-date.today{background:rgba(167,139,250,0.12);color:#a78bfa!important;font-weight:bold;}
        .m-date.cur-week{background:rgba(255,255,255,0.04);color:#6b7585;}
        .m-date.cur-week:hover{background:rgba(167,139,250,0.08);color:#a78bfa;}
        .m-date.cur-week.today{background:rgba(167,139,250,0.12);}

        .section-title{font-size:0.6rem;color:#5a6070;text-transform:uppercase;margin:18px 0 4px;font-weight:700;letter-spacing:2px;padding:0 2px;}
        .section-title-first{margin-top:10px!important;}

        .item{padding:7px 10px;font-size:0.82rem;cursor:pointer;color:#8892a4;transition:all 0.15s;background:transparent;margin-bottom:1px;border-left:3px solid transparent;position:relative;display:flex;align-items:center;flex-wrap:wrap;border-radius:0 6px 6px 0;}
        .item:hover{background:rgba(255,255,255,0.05);color:#d0d8e8;}
        .item.active{background:rgba(255,255,255,0.07);color:#fff;border-left-color:#a78bfa !important;}
        .trading-cat-item{color:#aab3c0;font-size:0.75rem!important;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;}
        .trading-cat-item:hover{background:rgba(255,255,255,0.04);color:#fff;}
        .sub-item{padding:6px 10px 6px 24px!important;font-size:0.81rem!important;color:#6b7585;margin-bottom:1px;border-left:3px solid transparent!important;border-radius:0 6px 6px 0;}
        .sub-item:hover{background:rgba(255,255,255,0.05)!important;color:#c8d0e0!important;}
        .sub-item.active{color:#fff!important;background:rgba(255,255,255,0.07)!important;}

        .item-name{flex:1;}
        .progress-container{width:100%;height:2px;background:#1e2030;margin-top:5px;border-radius:2px;overflow:hidden;}
        .progress-bar{height:100%;background:#a78bfa;transition:width 0.4s cubic-bezier(0.4,0,0.2,1);}
        .status-dot{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:7px;height:7px;background:#4caf50;border-radius:50%;box-shadow:0 0 6px #4caf50;animation:blink 2s infinite;}
        @keyframes blink{0%{opacity:1;transform:translateY(-50%) scale(1);}50%{opacity:0.35;transform:translateY(-50%) scale(0.75);}100%{opacity:1;transform:translateY(-50%) scale(1);}}
        .add-btn{background:linear-gradient(135deg,#a78bfa,#8b7ff0);border:none;padding:11px;font-weight:700;cursor:pointer;width:100%;border-radius:6px;margin-bottom:8px;font-family:'Oswald';color:#000;font-size:0.85rem;letter-spacing:1px;transition:0.15s;box-shadow:0 2px 8px rgba(167,139,250,0.25);}
        .add-btn:hover{background:linear-gradient(135deg,#b9a7f5,#a78bfa);box-shadow:0 4px 14px rgba(167,139,250,0.4);}

        /* Timeline */
        .timeline-viewport{flex-grow:1;overflow:auto;display:flex;flex-direction:column;}
        .timeline-header{display:flex;background:#fff;border-bottom:2px solid #ddd;min-width:max-content;}
        /* POINT 7: day-block still 960px, but 48 columns of 20px */
        .day-block{width:960px;border-right:2px solid #ccc;flex-shrink:0;}
        .today-block .day-label-top{background:#fff8e1!important;}
        .today-block{border-left:3px solid #a78bfa;border-right:3px solid #a78bfa!important;}
        .today-label{color:#a78bfa!important;}
        .weekend-block .day-label-top{background:#e8f1ff!important;}
        .weekend-block .hours-row{background:#eef4ff;}
        .day-label-top{background:#f4f4f4;padding:8px;font-weight:bold;text-align:center;border-bottom:1px solid #ddd;font-size:0.85rem;}
        .hours-row{display:flex;width:100%;height:28px;overflow:hidden;border-bottom:1px solid #f0f0f0;}
        .hr-cell{width:40px;min-width:40px;text-align:center;font-size:0.55rem;color:#999;font-weight:600;border-right:1px solid #bbb;display:block;box-sizing:border-box;height:100%;line-height:15px;padding-top:1px;position:relative;}
        .hr-half-mark{position:absolute;left:50%;top:14px;bottom:2px;border-left:1px dashed #bbb;}

        @keyframes rowSlideIn{from{opacity:0;transform:translateX(-12px);}to{opacity:1;transform:translateX(0);}}
        .timeline-row{display:flex;border-bottom:1px solid #eee;background:#fff;min-width:max-content;}
        .timeline-row.row-appearing{animation:rowSlideIn 0.25s ease forwards;}

        /* POINT 7: Grid lines every 20px and 40px */
        .row-grid-bg{
            display:flex;position:relative;height:66px;
            background-image:
                repeating-linear-gradient(to right, rgba(150,175,210,0.06) 0px, rgba(150,175,210,0.06) 1px, transparent 1px, transparent 40px),
                repeating-linear-gradient(to right, transparent 0px, transparent 960px, rgba(150,175,210,0.022) 960px, rgba(150,175,210,0.022) 1920px),
                linear-gradient(to right, transparent 4800px, rgba(110,160,230,0.07) 4800px, rgba(110,160,230,0.07) 6720px);
            width:6720px;
        }

        .shift-pill{position:absolute;border-radius:6px;color:#11151f;display:flex;align-items:center;padding:0 8px;font-size:0.65rem;font-weight:600;z-index:10;cursor:pointer;box-shadow:0 2px 8px rgba(15,19,32,0.35);transition:transform 0.1s,box-shadow 0.1s;white-space:nowrap;overflow:hidden;}
        .shift-pill:hover{transform:translateY(-2px);box-shadow:0 4px 14px rgba(0,0,0,0.4);z-index:100;}
        .shift-pill.overlap{outline:2px solid #ff4444;animation:overlapBlink 1s infinite;}
        @keyframes overlapBlink{0%{outline-color:#ff4444;box-shadow:0 0 8px #ff4444;}50%{outline-color:transparent;box-shadow:none;}100%{outline-color:#ff4444;box-shadow:0 0 8px #ff4444;}}
        .hidden-row{display:none!important;}

        /* POINT 1: Redesign modal – TeamUp style with dark theme */
        /* === Shift Modal — Drachir dark theme === */
        #modal{display:none;position:fixed;z-index:1000;left:0;top:0;width:100%;height:100%;background:rgba(5,5,12,0.82);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
        .modal-outer{background:#0d0e14;margin:3% auto;border-radius:16px;width:560px;max-width:96vw;overflow:hidden;color:#e0e0e0;box-shadow:0 32px 80px rgba(0,0,0,0.8),0 0 0 1px rgba(167,139,250,0.08);border:1px solid #1e2030;animation:modalSlideIn 0.25s cubic-bezier(0.16,1,0.3,1);}
        @keyframes modalSlideIn{0%{opacity:0;transform:translateY(16px) scale(0.97);}100%{opacity:1;transform:translateY(0) scale(1);}}
        .modal-header{padding:22px 24px 16px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid rgba(167,139,250,0.15);position:relative;overflow:hidden;}
        .modal-header::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(167,139,250,0.06) 0%,transparent 60%);pointer-events:none;}
        .modal-product-title{font-family:'Oswald',sans-serif;font-size:1.5rem;font-weight:700;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:5px;background:linear-gradient(135deg,#a78bfa 0%,#fff8e1 50%,#a78bfa 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
        .modal-person-row{font-size:0.8rem;color:rgba(255,255,255,0.5);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
        .modal-role-badge{font-size:0.6rem;padding:3px 10px;border-radius:12px;font-weight:600;letter-spacing:0.5px;border:1px solid rgba(255,255,255,0.1);}
        .modal-close-x{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#555;font-size:1.3rem;cursor:pointer;padding:4px 10px;border-radius:8px;transition:all 0.2s;flex-shrink:0;margin-left:10px;}
        .modal-close-x:hover{background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.2);color:#a78bfa;}
        .modal-info-strip{background:rgba(0,0,0,0.3);padding:14px 24px;display:flex;gap:24px;border-bottom:1px solid #1e2030;}
        .modal-info-item{display:flex;align-items:center;gap:8px;font-size:0.82rem;color:rgba(255,255,255,0.4);}
        .modal-info-icon{font-size:1rem;opacity:0.7;}
        .modal-info-value{font-weight:700;color:#fff;font-size:0.95rem;letter-spacing:0.3px;}
        .modal-tags-row{padding:12px 24px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid #1e2030;min-height:44px;}
        .modal-tag{font-size:0.65rem;padding:5px 14px;border-radius:20px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;border:1px solid rgba(255,255,255,0.06);}
        .modal-form-section{padding:18px 24px 14px;}
        .modal-form-section label{font-size:0.65rem;color:rgba(167,139,250,0.6);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:5px;margin-top:14px;font-weight:600;}
        .modal-form-section label:first-child{margin-top:0;}
        .modal-input{width:100%;padding:10px 14px;background:rgba(0,0,0,0.4);border:1px solid #1e2030;border-radius:8px;color:#fff;font-family:'Montserrat',sans-serif;font-size:0.85rem;box-sizing:border-box;transition:all 0.2s;color-scheme:dark;}
        .modal-input:focus{outline:none;border-color:rgba(167,139,250,0.5);background:rgba(0,0,0,0.6);box-shadow:0 0 0 3px rgba(167,139,250,0.08),0 0 16px rgba(167,139,250,0.06);}
        .modal-input:hover:not(:focus){border-color:#2a2d3a;}
        .date-pick-wrap{position:relative;flex:1;}
        .date-pick-display{width:100%;padding:10px 14px;background:rgba(0,0,0,0.4);border:1px solid #1e2030;border-radius:8px;color:#e8eaf0;font-family:'Montserrat',sans-serif;font-size:0.85rem;box-sizing:border-box;transition:all 0.2s;cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between;}
        .date-pick-display:hover{border-color:#2a2d3a;}
        .date-pick-display.open{border-color:rgba(167,139,250,0.5);background:rgba(0,0,0,0.6);box-shadow:0 0 0 3px rgba(167,139,250,0.08);}
        .date-pick-display .dp-icon{font-size:0.75rem;color:rgba(167,139,250,0.5);transition:color 0.2s;}
        .date-pick-display:hover .dp-icon,.date-pick-display.open .dp-icon{color:#a78bfa;}
        .dp-popup{display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:1000;background:#12131a;border:1px solid #1e2030;border-radius:10px;padding:12px 14px;box-shadow:0 8px 32px rgba(0,0,0,0.6),0 0 0 1px rgba(167,139,250,0.06);min-width:240px;}
        .dp-popup.show{display:block;}
        .dp-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
        .dp-nav button{background:none;border:none;color:#3a4050;cursor:pointer;font-size:0.85rem;padding:4px 8px;border-radius:4px;transition:0.15s;}
        .dp-nav button:hover{color:#a78bfa;background:rgba(167,139,250,0.08);}
        .dp-nav span{font-size:0.7rem;background:linear-gradient(90deg,#a78bfa,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;}
        .dp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;}
        .dp-hdr{font-size:0.55rem;color:#3a4050;font-weight:600;padding:4px 0;text-transform:uppercase;letter-spacing:0.5px;}
        .dp-day{font-size:0.72rem;padding:6px 2px;border-radius:6px;cursor:pointer;color:#6b7585;transition:all 0.12s;font-variant-numeric:tabular-nums;}
        .dp-day:hover{background:rgba(167,139,250,0.1);color:#a78bfa;}
        .dp-day.other{color:#252730;cursor:default;}
        .dp-day.other:hover{background:none;color:#252730;}
        .dp-day.today{color:#a78bfa;font-weight:700;background:rgba(167,139,250,0.08);}
        .dp-day.selected{background:rgba(167,139,250,0.2);color:#a78bfa;font-weight:700;box-shadow:0 0 8px rgba(167,139,250,0.15);}
        .dp-today-btn{display:block;width:100%;margin-top:8px;padding:5px 0;background:none;border:1px solid #1e2030;border-radius:6px;color:#3a4050;font-size:0.6rem;font-weight:600;cursor:pointer;text-transform:uppercase;letter-spacing:1px;transition:all 0.15s;font-family:'Montserrat',sans-serif;}
        .dp-today-btn:hover{border-color:rgba(167,139,250,0.3);color:#a78bfa;background:rgba(167,139,250,0.05);}
        .modal-row2{display:flex;gap:12px;}
        .modal-row2>div{flex:1;}
        .modal-actions{padding:18px 24px 22px;display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid #1e2030;background:rgba(0,0,0,0.15);}
        .modal-btn-confirm{flex:1;padding:12px;background:linear-gradient(135deg,#a78bfa 0%,#8b7ff0 100%);color:#000;border:none;border-radius:8px;font-weight:700;font-family:'Oswald',sans-serif;font-size:1rem;cursor:pointer;text-transform:uppercase;letter-spacing:1.5px;transition:all 0.2s;box-shadow:0 2px 12px rgba(167,139,250,0.2);}
        .modal-btn-confirm:hover{background:linear-gradient(135deg,#c4b5fd 0%,#a78bfa 100%);box-shadow:0 4px 20px rgba(167,139,250,0.35);transform:translateY(-1px);}
        .modal-btn-cancel{padding:12px 20px;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.06);border-radius:8px;cursor:pointer;font-size:0.85rem;transition:all 0.2s;}
        .modal-btn-cancel:hover{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);border-color:rgba(255,255,255,0.12);}
        .modal-btn-delete{padding:12px 16px;background:rgba(255,68,68,0.06);color:#ff5252;border:1px solid rgba(255,68,68,0.25);border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:700;transition:all 0.2s;letter-spacing:0.5px;}
        .modal-btn-delete:hover{background:rgba(255,68,68,0.15);border-color:rgba(255,68,68,0.5);box-shadow:0 0 16px rgba(255,68,68,0.1);}
        .modal-btn-exchange{padding:12px 16px;background:rgba(66,165,245,0.06);color:#42a5f5;border:1px solid rgba(66,165,245,0.25);border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:700;transition:all 0.2s;letter-spacing:0.5px;}
        .modal-btn-exchange:hover{background:rgba(66,165,245,0.15);border-color:rgba(66,165,245,0.5);box-shadow:0 0 16px rgba(66,165,245,0.1);}
        /* Exchange modal */
        #exchangeModal{display:none;position:fixed;z-index:1100;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);}
        #exchangeModal.picking-mode{background:transparent;pointer-events:none;top:auto;bottom:0;height:auto;}
        #exchangeModal.picking-mode .exchange-outer{pointer-events:all;margin:0 auto 0;border-radius:14px 14px 0 0;box-shadow:0 -4px 32px rgba(0,0,0,0.8);}
        .exchange-outer{background:#111;margin:3% auto;border-radius:14px;width:820px;max-width:95vw;overflow:hidden;color:#eee;box-shadow:0 24px 64px rgba(0,0,0,0.8);}
        .exchange-header{padding:20px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #222;}
        .exchange-header h2{font-family:'Oswald';color:#a78bfa;font-size:1.3rem;letter-spacing:2px;}
        .exchange-body{display:flex;gap:0;}
        .exchange-side{flex:1;padding:20px 24px;border-right:1px solid #222;}
        .exchange-side:last-child{border-right:none;}
        .exchange-side h3{font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;}
        .exchange-card{background:#1a1a1a;border-radius:8px;padding:14px;border:2px solid #333;margin-bottom:12px;}
        .exchange-card.selected{border-color:#a78bfa;}
        .exchange-card-title{font-family:'Oswald';font-size:1.1rem;color:#fff;margin-bottom:4px;}
        .exchange-card-sub{font-size:0.75rem;color:#aaa;}
        .exchange-card-time{font-size:0.8rem;color:#a78bfa;font-weight:700;margin-top:6px;}
        .exchange-footer{padding:16px 24px;border-top:1px solid #222;display:flex;gap:10px;justify-content:flex-end;}
        .exchange-confirm-btn{padding:11px 28px;background:#a78bfa;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';cursor:pointer;font-size:1rem;}
        .exchange-confirm-btn:hover{background:#fff;}
        .exchange-cancel-btn{padding:11px 20px;background:#222;color:#aaa;border:none;border-radius:6px;cursor:pointer;}
        /* Picking mode - cursor crosshair on pills */
        body.picking-exchange .shift-pill{cursor:crosshair!important;outline:2px dashed #42a5f5;animation:pickPulse 1s infinite;}
        @keyframes pickPulse{0%{outline-color:#42a5f5;}50%{outline-color:transparent;}100%{outline-color:#42a5f5;}}
        .picking-banner{display:none;position:fixed;top:0;left:0;right:0;padding:12px;background:#42a5f5;color:#000;text-align:center;font-weight:700;font-size:0.9rem;z-index:999;}
        body.picking-exchange .picking-banner{display:block;}
        /* Confirm dialog */
        #confirmDialog{display:none;position:fixed;z-index:2000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);}
        .confirm-box{background:#1a1a1a;margin:15% auto;padding:30px;border-radius:12px;width:380px;color:#eee;text-align:center;border:1px solid #333;}
        .confirm-box h3{margin-bottom:12px;color:#ff4444;}
        .confirm-box p{margin-bottom:24px;font-size:0.9rem;color:#aaa;line-height:1.5;}
        .confirm-btns{display:flex;gap:10px;justify-content:center;}
        .confirm-yes{padding:10px 28px;background:#ff4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;}
        .confirm-yes:hover{background:#ff6666;}
        .confirm-no{padding:10px 28px;background:#333;color:#aaa;border:none;border-radius:6px;cursor:pointer;}
        .confirm-no:hover{background:#444;color:#fff;}

        /* Loading spinner */
        .sync-spinner{display:inline-block;width:14px;height:14px;border:2px solid #a78bfa;border-top-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;}
        @keyframes spin{to{transform:rotate(360deg);}}

        /* Timezone toggle */
        .tz-toggle-btn{position:fixed;bottom:20px;right:20px;background:#0e1621;color:#c0d4e8;border:1px solid #2a4060;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:700;font-size:0.8rem;letter-spacing:1px;z-index:500;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:0.15s;display:flex;align-items:center;gap:8px;font-family:'Montserrat',sans-serif;}
        .tz-toggle-btn:hover{background:#162030;color:#e0ecf6;border-color:rgba(91,127,166,0.6);}
        .tz-badge{font-size:0.65rem;background:#0a1018;color:#6090b8;padding:2px 7px;border-radius:4px;font-family:'Montserrat';letter-spacing:1px;border:1px solid #2a4060;}
        .tz-toggle-btn:hover .tz-badge{background:#162030;color:#7ba3cc;}
        .tz-toggle-btn.lima-active{background:#162030;color:#e0ecf6;border-color:rgba(91,127,166,0.6);box-shadow:0 4px 16px rgba(91,127,166,0.15);}
        .tz-toggle-btn.lima-active .tz-badge{background:#0e1a28;color:#7ba3cc;border-color:rgba(91,127,166,0.5);}

        /* ===== Aurora · Soft · Glass (DARK) — theme override (restyle etapa 1: shell + timeline grid) ===== */
        :root{
          --au1:#a78bfa; --au2:#22d3ee; --au-grad:linear-gradient(135deg,#a78bfa 0%,#22d3ee 100%);
          --bg0:#11151d; --bg1:#161b25; --glass:rgba(34,41,63,0.55); --glass2:rgba(40,48,74,0.72);
          --gborder:rgba(165,180,252,0.16); --hair:rgba(165,180,252,0.10);
          --thi:#eef2fb; --tmid:#aab6cf; --tlo:#7c87a3;
        }
        body{ background:var(--bg0) !important; }
        .main-content{ background:var(--bg0) !important; }
        /* topbar glass */
        .topbar-main{ background:rgba(15,19,32,0.72) !important; backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-bottom:1px solid var(--gborder) !important; }
        .view-toggle-bar{ background:var(--glass) !important; border:1px solid var(--gborder) !important; }
        .topbar-right .btn-current-week,.topbar-right .btn-stats,.topbar-right .btn-swaps,.topbar-right .btn-ics,.topbar-right .btn-slack,.topbar-right .btn-theme,.topbar-right #refreshBtn{ background:var(--glass) !important; border-color:var(--gborder) !important; color:var(--tmid) !important; }
        .month-label{ color:var(--au2) !important; }
        .user-box{ background:var(--glass) !important; border-color:var(--gborder) !important; }
        /* sidebar glass */
        .sidebar{ background:rgba(15,19,32,0.62) !important; backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-right:1px solid var(--gborder) !important; }
        .logo-area{ border-bottom-color:var(--gborder) !important; }
        .logo-area img{ filter:drop-shadow(0 0 8px rgba(167,139,250,0.4)) !important; }
        .logo-fallback{ background:var(--au-grad) !important; -webkit-background-clip:text !important; background-clip:text !important; color:transparent !important; }
        .sidebar-list::-webkit-scrollbar-thumb{ background:rgba(167,139,250,0.5) !important; }
        .sidebar-list::-webkit-scrollbar-thumb:hover{ background:var(--au2) !important; }
        .sidebar-list{ scrollbar-color:rgba(167,139,250,0.45) transparent !important; }
        /* primary CTA + active items + mini-cal = aurora */
        .add-btn{ background:var(--au-grad) !important; color:#0f1320 !important; box-shadow:0 2px 14px rgba(167,139,250,0.30) !important; }
        .item.active{ border-left-color:var(--au1) !important; color:var(--thi) !important; }
        .sub-item.active{ color:var(--thi) !important; }
        .mini-calendar{ border-bottom-color:var(--gborder) !important; }
        .mini-cal-nav span{ background:linear-gradient(90deg,#a78bfa,#22d3ee) !important; -webkit-background-clip:text !important; background-clip:text !important; color:transparent !important; }
        .m-date.today{ background:rgba(167,139,250,0.16) !important; color:#c4b5fd !important; }
        .m-date:hover{ background:rgba(167,139,250,0.10) !important; color:var(--au1) !important; }
        .progress-container{ background:rgba(165,180,252,0.10) !important; }
        /* timeline grid -> dark */
        .timeline-viewport{ background:var(--bg0) !important; scrollbar-color:rgba(167,139,250,0.45) transparent; }
        .timeline-header{ background:var(--bg1) !important; border-bottom-color:var(--gborder) !important; }
        .timeline-row{ background:transparent !important; border-bottom-color:var(--hair) !important; }
        .timeline-row.zeb .row-grid-bg{ background-color:rgba(150,175,210,0.03); }
        .day-block{ border-right-color:var(--gborder) !important; }
        .hours-row{ background:rgba(255,255,255,0.025) !important; border-bottom-color:var(--hair) !important; }
        .hr-cell{ color:var(--tlo) !important; border-right-color:transparent !important; }
        .hr-half-mark{ display:none !important; }
        .day-label-top{ color:var(--thi) !important; }
        .today-label{ color:var(--au1) !important; }
        /* day headers: always dark bg + purple underline (readable on dark) */
        .day-label-top{ background:var(--bg1) !important; color:var(--thi) !important; border-bottom:2px solid rgba(167,139,250,0.45) !important; }
        .today-block .day-label-top{ background:rgba(167,139,250,0.16) !important; border-bottom-color:var(--au1) !important; }
        .weekend-block .day-label-top{ background:rgba(255,255,255,0.03) !important; }
        .weekend-block .hours-row{ background:rgba(255,255,255,0.02) !important; }
        .timeline-viewport::-webkit-scrollbar{ width:11px; height:11px; }
        .timeline-viewport::-webkit-scrollbar-track{ background:rgba(165,180,252,0.05); }
        .timeline-viewport::-webkit-scrollbar-thumb{ background:rgba(167,139,250,0.45); border-radius:10px; }
        .timeline-viewport::-webkit-scrollbar-thumb:hover{ background:var(--au2); }

        /* ===================== LIGHT THEME (toggle: html.theme-light) ===================== */
        .theme-light{
          --bg0:#eef1f6; --bg1:#ffffff; --glass:#ffffff; --glass2:#f5f7fa;
          --gborder:rgba(20,30,55,0.12); --hair:rgba(20,30,55,0.07);
          --thi:#1b2230; --tmid:#46526a; --tlo:#7c879c;
          --au1:#6d5bd6; --au2:#1f7fa8;
        }
        .theme-light body, .theme-light .main-content{ background:#eef1f6 !important; }
        .theme-light .topbar-main[style]{ background:#d7dce7 !important; border-bottom-color:var(--gborder) !important; }
        .theme-light .view-toggle-bar{ background:#eef1f6 !important; border-color:var(--gborder) !important; }
        .theme-light .sidebar{ background:#d7dce7 !important; border-right-color:var(--gborder) !important; }
        .theme-light .mini-calendar{ background:#cdd3e0 !important; border-radius:8px; padding:8px 8px 12px !important; }
        .theme-light #warriorSearch{ background:#f4f6fa !important; color:#1b2230 !important; border-color:var(--gborder) !important; }
        .theme-light .section-title{ color:#6e7a96 !important; }
        .theme-light .item{ color:#3c4860 !important; }
        .theme-light .sub-item{ color:#586480 !important; }
        .theme-light .item:hover, .theme-light .sub-item:hover{ background:rgba(20,40,90,0.05) !important; }
        .theme-light .month-label{ color:#3a6fae !important; }
        .theme-light .mini-cal-nav button{ color:#9aa3b5 !important; }
        .theme-light .mini-cal-grid, .theme-light .m-date{ color:#3c4860 !important; }
        .theme-light .m-date.today{ background:rgba(109,91,214,0.14) !important; color:#5a4fcf !important; }
        .theme-light .user-box{ background:#f4f6fa !important; }
        .theme-light .user-box [style*="color:#c8d0e0"]{ color:#1b2230 !important; }
        /* sidebar action buttons — darken light-on-dark accent text for white bg */
        .theme-light .sidebar-inner button[style*="#a78bfa"]{ color:#5a4fcf !important; }
        .theme-light .sidebar-inner a[style*="#90a4ae"]{ color:#566678 !important; }
        .theme-light .sidebar-inner button[style*="#b39ddb"]{ color:#7a5fc0 !important; }
        .theme-light .sidebar-inner button[style*="#66bb6a"]{ color:#3a9e4a !important; }
        /* timeline */
        .theme-light .timeline-viewport, .theme-light .timeline-header, .theme-light .timeline-row, .theme-light .hours-row{ background:#ffffff !important; }
        .theme-light .timeline-row{ border-bottom-color:rgba(30,45,90,0.16) !important; }
        .theme-light .day-label-top{ background:#f4f6fa !important; color:#1b2230 !important; border-bottom-color:rgba(109,91,214,0.4) !important; }
        .theme-light .today-block .day-label-top{ background:rgba(109,91,214,0.12) !important; }
        .theme-light .weekend-block .day-label-top{ background:rgba(70,120,210,0.08) !important; }
        .theme-light .weekend-block .hours-row{ background:rgba(70,120,210,0.05) !important; }
        .theme-light .hr-cell{ color:#8a93a8 !important; }
        .theme-light .row-label{ color:#5a6480 !important; text-shadow:none !important; }
        .theme-light .row-grid-bg{
            background-color:#ffffff !important;
            background-image:
                repeating-linear-gradient(to right, rgba(30,45,90,0.12) 0px, rgba(30,45,90,0.12) 1px, transparent 1px, transparent 40px),
                repeating-linear-gradient(to right, transparent 0px, transparent 960px, rgba(30,45,90,0.02) 960px, rgba(30,45,90,0.02) 1920px),
                linear-gradient(to right, transparent 4800px, rgba(70,120,210,0.06) 4800px, rgba(70,120,210,0.06) 6720px) !important;
        }
        .theme-light .timeline-row.zeb .row-grid-bg{ background-color:#f5f7fb !important; }
        .theme-light .timeline-viewport::-webkit-scrollbar-track{ background:rgba(20,40,90,0.04); }
        .theme-light .timeline-viewport::-webkit-scrollbar-thumb{ background:rgba(109,91,214,0.4); }
        /* shift modal */
        .theme-light .modal-outer{ background:#ffffff !important; color:#1b2230 !important; border-color:var(--gborder) !important; }
        /* WEEK / LIST / AGENDA views — light surfaces (these are built with hardcoded dark inline bg) */
        .theme-light [style*="background:#0f1320"]{ background:#ffffff !important; }
        .theme-light [style*="background:#131826"]{ background:#f1f3f7 !important; color:#46526a; }
        .theme-light [style*="background:#161b2c"]{ background:#e9edf4 !important; color:#46526a; }
        /* week/list faint blue grid lines -> visible grey on white */
        .theme-light [style*="rgba(165,180,252,0.14)"]{ border-color:rgba(40,55,95,0.22) !important; }
        .theme-light [style*="rgba(165,180,252,0.09)"]{ border-color:rgba(40,55,95,0.16) !important; }
        .theme-light [style*="rgba(165,180,252,0.08)"]{ border-color:rgba(40,55,95,0.15) !important; }
        .theme-light [style*="rgba(165,180,252,0.06)"]{ border-color:rgba(40,55,95,0.10) !important; }
        .theme-light .week-grid-row, .theme-light .week-header-row, .theme-light .list-viewport, .theme-light .list-wrapper{ color:#46526a; }
        .theme-light .week-header-row [style*="color:#a78bfa"], .theme-light [style*="color:#a78bfa"]{ color:#5a4fcf !important; }
        /* ---- inline dark surfaces everywhere (chrome + JS-built overlays: swap board, people admin, modals, selects) ---- */
        .theme-light [style*="background:#0d0e14"], .theme-light [style*="background:#0a0b0f"], .theme-light [style*="background:#0a1018"], .theme-light [style*="background:#1a1a1a"], .theme-light [style*="background:#1c1c1c"], .theme-light [style*="background:#12131a"], .theme-light [style*="background:#13141c"]{ background:#f6f7fb !important; }
        .theme-light [style*="background:#0e1621"], .theme-light [style*="background:#13151e"], .theme-light [style*="background:#162030"]{ background:#eef0f4 !important; }
        .theme-light [style*="background:#2a2d3a"]{ background:#e4e7ee !important; }
        /* light-on-dark text -> dark for white surfaces */
        .theme-light [style*="color:#c8d0e0"], .theme-light [style*="color:#dfe6f2"], .theme-light [style*="color:#e8ecf4"], .theme-light [style*="color:#e8eaf0"], .theme-light [style*="color:#eef2fb"], .theme-light [style*="color:#e0ecf6"], .theme-light [style*="color:#f2f5fb"], .theme-light [style*="color:#e0e0e0"], .theme-light [style*="color:#eee"]{ color:#1b2230 !important; }
        .theme-light [style*="color:#8892a4"], .theme-light [style*="color:#7c87a3"], .theme-light [style*="color:#aab6cf"], .theme-light [style*="color:#a7b4c8"], .theme-light [style*="color:#aab4c8"], .theme-light [style*="color:#9aadc7"], .theme-light [style*="color:#bcd0ea"], .theme-light [style*="color:#c0d4e8"], .theme-light [style*="color:#8a93ab"], .theme-light [style*="color:#cdd"], .theme-light [style*="color:#ccc"], .theme-light [style*="color:#9aa"]{ color:#46526a !important; }
        .theme-light [style*="color:#6b7585"], .theme-light [style*="color:#6b768f"]{ color:#4a5568 !important; }
        .theme-light [style*="color:#7ba3cc"]{ color:#2f6193 !important; }
        .theme-light [style*="color:#5b7fa6"]{ color:#345f86 !important; }
        .theme-light [style*="color:#82b4ff"], .theme-light [style*="color:#8fb4e4"]{ color:#3163ad !important; }
        .theme-light [style*="color:#b39ddb"]{ color:#7a5fc0 !important; }
        .theme-light [style*="color:#a5d6a7"]{ color:#4e9e54 !important; }
        /* accent texts: keep hue but darken so they read on white surfaces */
        .theme-light [style*="color:#42a5f5"], .theme-light [style*="color:#64b5f6"]{ color:#1f6fc8 !important; }
        .theme-light [style*="color:#66bb6a"]{ color:#3a9e4a !important; }
        .theme-light [style*="color:#ff6b6b"], .theme-light [style*="color:#ff4444"], .theme-light [style*="color:#e57373"], .theme-light [style*="color:#ef9a9a"]{ color:#cc3b3b !important; }
    </style>
    <!-- Early: restore saved view + hide unselected rows before first paint -->
    <script>
    (function(){
        try{ if(localStorage.getItem('ygg_theme')==='light') document.documentElement.classList.add('theme-light'); }catch(e){}
        // Restore saved view if no ?view= in URL
        const p=new URLSearchParams(window.location.search);
        if(!p.has('view')){
            const sv=localStorage.getItem('ygg_view');
            if(sv && ['timeline','week','list','agenda'].includes(sv) && sv!=='timeline'){
                p.set('view',sv);
                window.location.replace('/dashboard?'+p.toString());
                return;
            }
        }
        const names=(localStorage.getItem('ygg_sel_names')||'').split('||').filter(Boolean);
        const prods=(localStorage.getItem('ygg_sel_prods')||'').split('||').filter(Boolean);
        if(names.length||prods.length){
            const s=document.createElement('style');
            s.id='pre-filter-style';
            s.textContent='.user-row,.product-row{display:none!important;}.hidden-row{display:none!important;}';
            document.head.appendChild(s);
        }
    })();
    </script>
</head>
<body>
<div class="dashboard-container">
    <aside class="sidebar">
        <div class="logo-area">
            <img src="images/oddin-logo.png" alt="Oddin.gg" style="mix-blend-mode:lighten;opacity:0.85;" onerror="this.style.display='none';">
            <span class="logo-fallback">DRACHIR.GG</span>
        </div>
        <div class="sidebar-inner">
        <input type="text" id="warriorSearch" placeholder="&#128269; Search traders..." onkeyup="filterWarriors()" style="width:100%;padding:8px 10px;background:#13151e;border:1px solid #1e2030;color:#8892a4;border-radius:6px;margin-bottom:12px;box-sizing:border-box;font-size:0.8rem;outline:none;transition:0.15s;" onfocus="this.style.borderColor='rgba(167,139,250,0.4)';this.style.color='#d0d8e8'" onblur="this.style.borderColor='#1e2030';this.style.color='#8892a4'">

        <div class="mini-calendar" id="miniCal"></div>

        <button class="add-btn" onclick="openAddModal()">+ ADD NEW </button>
        ${(['David Winkler','Ondřej Merxbauer'].includes(req.user.jmeno) || req.user.role === 'Admin' || ['Lukáš Novotný', 'Filip Sklenička', 'Jindřich Lacina', 'David Trocino', 'David Lamač', 'Tomáš Komenda', 'Dominik Chvátal', 'Marcelo Goto'].includes(req.user.jmeno)) ? '<button onclick="openExportModal()" style="background:rgba(76,175,80,0.1);color:#66bb6a;border:1px solid rgba(76,175,80,0.3);padding:7px;width:100%;cursor:pointer;font-weight:bold;margin-bottom:6px;border-radius:6px;font-size:0.72rem;transition:0.15s;" onmouseover="this.style.background=\'rgba(76,175,80,0.2)\'" onmouseout="this.style.background=\'rgba(76,175,80,0.1)\'">&#128190; EXPORT CSV</button>' : ''}
        ${req.user && req.user.role === 'Admin' ? `
        <button onclick="openSyncModal()" style="background:rgba(167,139,250,0.08);color:#a78bfa;border:1px solid rgba(167,139,250,0.25);padding:9px;width:100%;cursor:pointer;font-weight:bold;margin-bottom:6px;border-radius:6px;font-size:0.75rem;transition:0.15s;" onmouseover="this.style.background='rgba(167,139,250,0.15)'" onmouseout="this.style.background='rgba(167,139,250,0.08)'" id="syncBtn">SYNC WITH SCHEDULE</button>
        <a href="/admin/audit-log" style="display:block;box-sizing:border-box;text-align:center;text-decoration:none;background:rgba(120,144,156,0.08);color:#90a4ae;border:1px solid rgba(120,144,156,0.3);padding:9px;width:100%;cursor:pointer;font-weight:bold;margin-bottom:6px;border-radius:6px;font-size:0.75rem;transition:0.15s;" onmouseover="this.style.background='rgba(120,144,156,0.18)'" onmouseout="this.style.background='rgba(120,144,156,0.08)'">&#128203; AUDIT LOG</a>
        <button onclick="openPeopleAdmin()" style="display:block;box-sizing:border-box;text-align:center;background:rgba(126,87,194,0.1);color:#b39ddb;border:1px solid rgba(126,87,194,0.35);padding:9px;width:100%;cursor:pointer;font-weight:bold;margin-bottom:6px;border-radius:6px;font-size:0.75rem;transition:0.15s;" onmouseover="this.style.background='rgba(126,87,194,0.2)'" onmouseout="this.style.background='rgba(126,87,194,0.1)'">&#128101; MANAGE PEOPLE</button>
        <button onclick="openDeleteMonth()" style="background:rgba(255,68,68,0.06);color:#ff6b6b;border:1px solid rgba(255,68,68,0.2);padding:7px;width:100%;cursor:pointer;font-weight:bold;margin-bottom:16px;border-radius:6px;font-size:0.72rem;transition:0.15s;" onmouseover="this.style.background='rgba(255,68,68,0.15)'" onmouseout="this.style.background='rgba(255,68,68,0.06)'">DELETE ALL SHIFTS THIS MONTH</button>
        ` : ''}

        <div class="item" id="showAllBtn" onclick="showAllRows(this)" style="border-left-color:rgba(255,255,255,0.2);color:#6b7585;font-size:0.72rem;letter-spacing:1px;">[ SHOW ALL ]</div>
        <div style="display:flex;gap:6px;margin:2px 0 6px;">
            <button class="mine-btn" id="mineBtn" onclick="showMine(false)" title="Show only my shifts (click again to hide)" style="flex:1;background:rgba(167,139,250,0.10);color:#a78bfa;border:1px solid rgba(167,139,250,0.30);border-radius:6px;padding:6px 4px;font-size:0.66rem;font-weight:700;letter-spacing:0.5px;cursor:pointer;transition:0.15s;">&#9733; MY SHIFTS</button>
            <button class="mine-btn" id="minePlusBtn" onclick="showMine(true)" title="My shifts + the products I work — see who is on after me (click again to hide)" style="flex:1;background:rgba(34,211,238,0.10);color:#22d3ee;border:1px solid rgba(34,211,238,0.30);border-radius:6px;padding:6px 4px;font-size:0.66rem;font-weight:700;letter-spacing:0.5px;cursor:pointer;transition:0.15s;">&#9733; MY + PRODUCTS</button>
        </div>

        <div class="sidebar-list">
        ${peopleHierarchy.map((g, gi) =>
            '<div class="section-title' + (gi===0?' section-title-first':'') + '" onclick="toggleSection(\'grp-' + gi + '\',this)" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none;">'
            + '<span>' + g.label + '</span>'
            + '<span class="section-chevron" style="font-size:0.55rem;transition:transform 0.2s;display:inline-block;">&#9660;</span>'
            + '</div>'
            + '<div class="section-group" id="grp-' + gi + '">'
            + g.members.map(n => {
                const pc = personColors[n] || g.color;
                const pc_target = targetHours[n] || 0;
                const pct = pc_target > 0 ? Math.min((weekStats[n]||0)/pc_target*100,100) : 0;
                const hoursColor = pct >= 100 ? '#4caf50' : pc;
                return '<div class="item user-item" data-name="' + n + '" style="border-left-color:' + pc + '" onclick="toggleSelect(\'' + n.replace(/'/g,'') + '\',this)">'
                     + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + pc + ';margin-right:8px;flex-shrink:0;box-shadow:0 0 5px ' + pc + '66;"></span>'
                     + '<span class="item-name" style="font-size:0.8rem;">' + n + '</span>'
                     + (activeWarriors.has(n) ? '<span class="status-dot"></span>' : '')
                     + (pc_target > 0 ? '<div style="width:100%;display:flex;align-items:center;gap:5px;margin-top:4px;">'
                     + '<div class="progress-container" style="flex:1;"><div class="progress-bar" style="width:' + pct + '%;background:' + hoursColor + ';box-shadow:0 0 4px ' + hoursColor + '66;"></div></div>'
                     + '<span style="font-size:0.58rem;color:' + hoursColor + ';opacity:0.85;flex-shrink:0;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;text-shadow:0 0 8px ' + hoursColor + '33;">' + Math.round((weekStats[n]||0)*10)/10 + '/' + pc_target + 'h</span>'
                     + '</div>' : '')
                     + '</div>';
            }).join('') + '</div>'
        ).join('')}

        <div class="section-title" style="margin-top:20px;">Trading Products</div>
        ${tradingHierarchy.map(t =>
            '<div class="item trading-cat-item" style="border-left-color:' + t.color + ';color:' + t.color + '88;" onclick="filterByTrading(\'' + t.name + '\',this)">'
            + '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + t.color + ';margin-right:7px;flex-shrink:0;opacity:0.6;"></span>'
            + t.icon + ' ' + t.name + '</div>'
            + t.subs.map(sub => {
                const sc = productColors[sub] || t.color;
                return '<div class="item sub-item product-selector" data-product-name="' + sub + '" data-trading="' + t.name + '" style="border-left-color:' + sc + '" onclick="toggleProduct(\'' + sub.replace(/'/g,'') + '\',this)">'
                + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + sc + ';margin-right:8px;flex-shrink:0;box-shadow:0 0 4px ' + sc + '66;"></span>'
                + sub + '</div>';
            }).join('')
        ).join('')}
        </div>
        <div style="padding:12px 16px;border-top:1px solid #1e2030;flex-shrink:0;">
            <button class="sidebar-color-btn" onclick="openColorPicker()" style="width:100%;padding:9px;background:rgba(255,255,255,0.03);border:1px solid #1e2030;border-radius:8px;color:#5b7fa6;cursor:pointer;font-size:0.72rem;font-weight:600;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s;margin-bottom:6px;" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='rgba(255,255,255,0.03)'">&#127912; Color Settings</button>
            <button class="sidebar-tz-toggle" onclick="toggleTimezone()" style="width:100%;padding:9px;background:#0e1621;border:1px solid #2a4060;border-radius:8px;color:#c0d4e8;cursor:pointer;font-size:0.72rem;font-weight:700;letter-spacing:1px;align-items:center;justify-content:center;gap:8px;transition:all 0.2s;margin-bottom:8px;font-family:'Montserrat',sans-serif;">&#127757; <span class="sidebar-tz-label">EUROPE</span> <span class="tz-badge" style="font-size:0.6rem;background:#0a1018;color:#6090b8;padding:2px 7px;border-radius:4px;letter-spacing:1px;border:1px solid #2a4060;">-&gt; LIMA</span></button>
            <div class="sidebar-logout-btn">
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0 10px;">
                    <div style="width:32px;height:32px;border-radius:50%;background:#0a0b0f;border:2px solid rgba(167,139,250,0.25);display:flex;align-items:center;justify-content:center;font-family:'Oswald';font-weight:700;color:#a78bfa;font-size:0.9rem;flex-shrink:0;">${req.user.jmeno ? req.user.jmeno.charAt(0).toUpperCase() : '?'}</div>
                    <div>
                        <div style="font-weight:700;font-size:0.85rem;color:#c8d0e0;">${req.user.jmeno || ''}</div>
                        <span style="font-size:0.6rem;padding:1px 7px;border-radius:10px;font-weight:700;${req.user.role === 'Admin' ? 'background:rgba(167,139,250,0.1);color:#a78bfa;border:1px solid rgba(167,139,250,0.22);' : 'background:rgba(33,150,243,0.1);color:#64b5f6;border:1px solid rgba(33,150,243,0.22);'}">${req.user.role || 'User'}</span>
                    </div>
                </div>
                <a href="/logout" style="display:block;width:100%;padding:10px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:8px;color:#a78bfa;font-size:0.75rem;font-weight:700;font-family:'Oswald',sans-serif;letter-spacing:1.5px;text-transform:uppercase;text-align:center;text-decoration:none;transition:all 0.2s;box-sizing:border-box;" onmouseover="this.style.background='rgba(167,139,250,0.18)'" onmouseout="this.style.background='rgba(167,139,250,0.08)'">&#10151; LOGOUT</a>
            </div>
        </div>
        </div>
    </aside>

    <main class="main-content" style="display:flex;flex-direction:column;overflow:hidden;background:#fafafa;">
        <div class="topbar-main" style="padding:10px 20px;border-bottom:1px solid #1e2030;display:flex;justify-content:space-between;align-items:center;background:#0d0e14;">
            <div class="topbar-left" style="display:flex;align-items:center;gap:10px;">
                <!-- POINT 1: Mobile menu button -->
                <button class="mobile-menu-btn" onclick="toggleMobileMenu()" title="Menu">&#9776;</button>
                <div class="view-toggle-bar" style="background:#13151e;border-radius:8px;padding:3px;display:inline-flex;gap:1px;border:1px solid #1e2030;">
                    <button onclick="switchView('timeline')" style="padding:6px 13px;border:none;cursor:pointer;border-radius:5px;font-weight:700;font-size:0.75rem;letter-spacing:0.5px;transition:0.15s;${view==='timeline'?'background:linear-gradient(135deg,rgba(167,139,250,0.30),rgba(34,211,238,0.20));color:#eef2fb;':'background:transparent;color:#4a5060;'}">TIMELINE</button>
                    <button onclick="switchView('week')" style="padding:6px 13px;border:none;cursor:pointer;border-radius:5px;font-weight:700;font-size:0.75rem;letter-spacing:0.5px;transition:0.15s;${view==='week'?'background:linear-gradient(135deg,rgba(167,139,250,0.30),rgba(34,211,238,0.20));color:#eef2fb;':'background:transparent;color:#4a5060;'}">WEEK</button>
                    <button class="vt-list" onclick="switchView('list')" style="padding:6px 13px;border:none;cursor:pointer;border-radius:5px;font-weight:700;font-size:0.75rem;letter-spacing:0.5px;transition:0.15s;${view==='list'?'background:linear-gradient(135deg,rgba(167,139,250,0.30),rgba(34,211,238,0.20));color:#eef2fb;':'background:transparent;color:#4a5060;'}">LIST</button>
                    <button onclick="switchView('agenda')" style="padding:6px 13px;border:none;cursor:pointer;border-radius:5px;font-weight:700;font-size:0.75rem;letter-spacing:0.5px;transition:0.15s;${view==='agenda'?'background:linear-gradient(135deg,rgba(167,139,250,0.30),rgba(34,211,238,0.20));color:#eef2fb;':'background:transparent;color:#4a5060;'}">AGENDA</button>
                </div>
            </div>
            <div class="topbar-right" style="display:flex;align-items:center;gap:12px;">
                <div class="month-label" style="font-weight:700;font-size:0.9rem;color:#5b7fa6;font-family:'Oswald';letter-spacing:1.5px;">${queryDate.toLocaleDateString('en-GB',{month:'long',year:'numeric'}).toUpperCase()}</div>
                <button class="btn-current-week" onclick="location.href='/dashboard'" style="padding:6px 14px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-weight:700;font-size:0.72rem;letter-spacing:0.5px;transition:0.15s;" onmouseover="this.style.borderColor='rgba(91,127,166,0.5)';this.style.color='#7ba3cc'" onmouseout="this.style.borderColor='#1e2d3d';this.style.color='#5b7fa6'">CURRENT WEEK</button>
                <a href="/stats" class="btn-stats" title="Statistics" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;transition:all 0.3s;line-height:1;text-decoration:none;" onmouseover="this.style.borderColor='rgba(91,127,166,0.5)';this.style.color='#7ba3cc'" onmouseout="this.style.borderColor='#1e2d3d';this.style.color='#5b7fa6'">&#128202;</a>
                <button class="btn-swaps" onclick="openSwapBoard()" title="Shift swaps" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;transition:all 0.3s;line-height:1;" onmouseover="this.style.borderColor='rgba(91,127,166,0.5)';this.style.color='#7ba3cc'" onmouseout="this.style.borderColor='#1e2d3d';this.style.color='#5b7fa6'">&#128260;</button>
                <a href="/calendar" class="btn-ics" title="My calendar (ICS feed)" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;transition:all 0.3s;line-height:1;text-decoration:none;" onmouseover="this.style.borderColor='rgba(91,127,166,0.5)';this.style.color='#7ba3cc'" onmouseout="this.style.borderColor='#1e2d3d';this.style.color='#5b7fa6'">&#128197;</a>
                <button class="btn-slack" onclick="openSlackSettings()" title="Slack Notifications" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;transition:all 0.3s;line-height:1;" onmouseover="this.style.borderColor='rgba(91,127,166,0.5)';this.style.color='#7ba3cc'" onmouseout="this.style.borderColor='#1e2d3d';this.style.color='#5b7fa6'">&#128276;</button>
                <button class="btn-move" id="moveModeBtn" onclick="toggleMoveMode()" title="Move mode — drag your shifts on the timeline to reschedule within the day (click again to exit)" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;line-height:1;">&#10021;</button>
                <button id="undoBtn" onclick="dragUndo()" title="Undo move (Ctrl+Z)" style="display:none;padding:6px 9px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.9rem;line-height:1;">&#8617;</button>
                <button id="redoBtn" onclick="dragRedo()" title="Redo move (Ctrl+Y)" style="display:none;padding:6px 9px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.9rem;line-height:1;">&#8618;</button>
                <span style="position:relative;display:inline-flex;">
                    <button class="btn-bell" id="bellBtn" onclick="toggleBell()" title="Notifications" style="position:relative;padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;transition:all 0.3s;line-height:1;">&#128276;<span id="bellBadge" style="display:none;position:absolute;top:-5px;right:-5px;background:#ef5350;color:#fff;border-radius:10px;font-size:0.58rem;min-width:15px;height:15px;line-height:15px;text-align:center;font-weight:700;padding:0 2px;">0</span></button>
                    <div id="bellPanel" style="display:none;position:absolute;top:120%;right:0;width:300px;max-height:400px;overflow:auto;background:#13151e;border:1px solid #1e2030;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,0.55);z-index:3000;padding:6px;"></div>
                </span>
                <button id="refreshBtn" onclick="refreshDashboard()" title="Refresh data" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;transition:all 0.3s;line-height:1;" onmouseover="this.style.borderColor='rgba(91,127,166,0.5)';this.style.color='#7ba3cc'" onmouseout="this.style.borderColor='#1e2d3d';this.style.color='#5b7fa6'">&#10227;</button>
                <button id="themeToggle" class="btn-theme" onclick="toggleTheme()" title="Light / Dark theme" style="padding:6px 10px;border:1px solid #1e2d3d;border-radius:6px;background:#0e1621;color:#5b7fa6;cursor:pointer;font-size:0.85rem;line-height:1;">&#9728;</button><script>if(document.documentElement.classList.contains('theme-light')){var _thBtn=document.getElementById('themeToggle');if(_thBtn)_thBtn.textContent='☾';}</script>
                <!-- Uzivatel desktop -->
                <div class="user-box" style="display:flex;align-items:center;gap:10px;padding:7px 12px;background:#13151e;border-radius:10px;border:1px solid #1e2030;">
                    <div style="width:36px;height:36px;border-radius:50%;background:#0a0b0f;border:2px solid rgba(167,139,250,0.25);display:flex;align-items:center;justify-content:center;font-family:'Oswald';font-weight:700;color:#a78bfa;font-size:1rem;flex-shrink:0;">
                        ${req.user.jmeno ? req.user.jmeno.charAt(0).toUpperCase() : '?'}
                    </div>
                    <div style="line-height:1.4;">
                        <div style="font-weight:700;font-size:0.88rem;color:#c8d0e0;">${req.user.jmeno || ''}</div>
                        <div style="display:flex;align-items:center;gap:5px;margin-top:2px;">
                            <span style="font-size:0.65rem;padding:1px 7px;border-radius:10px;font-weight:700;${req.user.role === 'Admin' ? 'background:rgba(167,139,250,0.1);color:#a78bfa;border:1px solid rgba(167,139,250,0.22);' : 'background:rgba(33,150,243,0.1);color:#64b5f6;border:1px solid rgba(33,150,243,0.22);'}">${req.user.role || 'User'}</span>
                            ${req.user.location ? '<span style="font-size:0.65rem;color:#2e3348;">· ' + req.user.location + '</span>' : ''}
                        </div>
                    </div>
                    <a href="/change-password" style="padding:6px 11px;background:#0a0b0f;color:#3a4050;border-radius:6px;text-decoration:none;font-size:0.68rem;border:1px solid #1e2030;transition:0.15s;" onmouseover="this.style.color='#8892a4';this.style.borderColor='#2e3348'" onmouseout="this.style.color='#3a4050';this.style.borderColor='#1e2030'" title="Change Password">&#128274; PWD</a>
                    <a href="/logout" style="padding:6px 14px;background:rgba(167,139,250,0.08);color:#a78bfa;border-radius:6px;text-decoration:none;font-size:0.75rem;font-weight:700;font-family:'Oswald';letter-spacing:1px;border:1px solid rgba(167,139,250,0.2);transition:0.15s;" onmouseover="this.style.background='rgba(167,139,250,0.18)'" onmouseout="this.style.background='rgba(167,139,250,0.08)'">LOGOUT</a>
                </div>
                <!-- Uzivatel mobile - compact -->
                <div class="mobile-user-compact" style="align-items:center;gap:5px;padding:4px 8px;background:#13151e;border-radius:8px;border:1px solid #1e2030;cursor:pointer;position:relative;" onclick="var m=document.getElementById('mobileUserMenu');m.style.display=m.style.display==='block'?'none':'block';">
                    <div style="width:24px;height:24px;border-radius:50%;background:#0a0b0f;border:1.5px solid rgba(167,139,250,0.25);display:flex;align-items:center;justify-content:center;font-family:'Oswald';font-weight:700;color:#a78bfa;font-size:0.7rem;flex-shrink:0;">
                        ${req.user.jmeno ? req.user.jmeno.charAt(0).toUpperCase() : '?'}
                    </div>
                    <span style="color:#c8d0e0;font-size:0.65rem;font-weight:600;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${req.user.jmeno || ''}</span>
                    <div id="mobileUserMenu" style="display:none;position:absolute;top:100%;right:0;margin-top:6px;background:#13151e;border:1px solid #1e2030;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.6);min-width:140px;z-index:999;overflow:hidden;">
                        <a href="/change-password" style="display:block;padding:10px 14px;color:#8892a4;text-decoration:none;font-size:0.72rem;border-bottom:1px solid #1e2030;transition:0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">&#128274; Change Password</a>
                        <a href="/logout" style="display:block;padding:10px 14px;color:#a78bfa;text-decoration:none;font-size:0.72rem;font-weight:700;transition:0.15s;" onmouseover="this.style.background='rgba(167,139,250,0.08)'" onmouseout="this.style.background='transparent'">&#10151; Logout</a>
                    </div>
                </div>
            </div>
        </div>
        ${mainContentHTML}
    </main>
</div>

<!-- POINT 1: Redesigned modal – TeamUp style -->
<div id="modal">
    <div class="modal-outer">
        <div class="modal-header" id="mHeader">
            <div style="flex:1;">
                <div class="modal-product-title" id="mProductDisplay">-</div>
                <div class="modal-person-row">
                    <span id="mPersonDisplay" style="font-weight:600;color:#fff;">-</span>
                    <span class="modal-role-badge" id="mRoleBadge">-</span>
                </div>
            </div>
            <button class="modal-close-x" onclick="closeModal()" title="Close">&times;</button>
        </div>
        <div class="modal-info-strip">
            <div class="modal-info-item">
                <span class="modal-info-icon">&#128197;</span>
                <span class="modal-info-value" id="mDateDisplay">-</span>
            </div>
            <div class="modal-info-item">
                <span class="modal-info-icon">&#128336;</span>
                <span class="modal-info-value" id="mTimeDisplay">-</span>
            </div>
        </div>
        <div class="modal-tags-row" id="mTagsRow"></div>
        <div id="mCrewDisplay" style="display:none;padding:8px 24px 12px;"></div>
        <div class="modal-form-section">
            <input type="hidden" id="mMode">
            <input type="hidden" id="oName">
            <input type="hidden" id="oDate">
            <input type="hidden" id="oStart">
            <label>Trader</label>
            <select id="mName" class="modal-input">${allNames.map(n => '<option value="' + n + '">' + n + '</option>').join('')}</select>
            <div id="mExtraTradersWrap" style="margin-top:6px;">
                <div id="mExtraTradersList" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;"></div>
                <button type="button" id="mAddTraderBtn" onclick="addExtraTrader()" style="padding:5px 12px;background:rgba(76,175,80,0.1);color:#66bb6a;border:1px solid rgba(76,175,80,0.25);border-radius:6px;cursor:pointer;font-size:0.7rem;font-weight:600;letter-spacing:0.5px;" onmouseover="this.style.background='rgba(76,175,80,0.2)'" onmouseout="this.style.background='rgba(76,175,80,0.1)'">+ Add Trader</button>
            </div>
            <label>Date</label>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="hidden" id="mDate">
                <div class="date-pick-wrap" id="dpWrap1">
                    <div class="date-pick-display" onclick="dpToggle('dp1')"><span id="dp1Text">--.--.----</span><span class="dp-icon">&#128197;</span></div>
                    <div class="dp-popup" id="dp1"></div>
                </div>
                <span id="mDateToLabel" style="display:none;font-size:0.7rem;color:rgba(167,139,250,0.6);font-weight:600;white-space:nowrap;">to</span>
                <input type="hidden" id="mDateTo">
                <div class="date-pick-wrap" id="dpWrap2" style="display:none;">
                    <div class="date-pick-display" onclick="dpToggle('dp2')"><span id="dp2Text">--.--.----</span><span class="dp-icon">&#128197;</span></div>
                    <div class="dp-popup" id="dp2"></div>
                </div>
                <button type="button" id="mMultiDayBtn" onclick="toggleMultiDay()" style="padding:5px 10px;background:rgba(91,127,166,0.08);color:rgba(91,127,166,0.7);border:1px solid rgba(91,127,166,0.2);border-radius:6px;cursor:pointer;font-size:0.62rem;font-weight:600;letter-spacing:0.5px;white-space:nowrap;display:none;" onmouseover="this.style.background='rgba(91,127,166,0.18)'" onmouseout="if(!this.classList.contains('active')){this.style.background='rgba(91,127,166,0.08)'}">Multi-day</button>
            </div>
            <label>Trading Category</label>
            <select id="mTrading" class="modal-input" onchange="updateProductDropdown()">${tradingHierarchy.map(t => '<option value="' + t.name + '">' + t.name + '</option>').join('')}</select>
            <label>Product</label>
            <select id="mProd" class="modal-input">
                <option value="">-- Select Product --</option>
            </select>
            <div class="modal-row2">
                <div><label>Start</label><input type="text" id="mStart" class="modal-input" placeholder="07:00"></div>
                <div><label>End</label><input type="text" id="mEnd" class="modal-input" placeholder="15:00"></div>
            </div>
            <div style="margin-top:10px;">
                <button type="button" id="mAllDayBtn" onclick="toggleAllDay()" style="padding:7px 18px;background:rgba(167,139,250,0.08);color:rgba(167,139,250,0.7);border:1px solid rgba(167,139,250,0.2);border-radius:8px;cursor:pointer;font-size:0.75rem;font-weight:600;letter-spacing:1px;text-transform:uppercase;transition:all 0.2s;" onmouseover="this.style.background='rgba(167,139,250,0.15)';this.style.borderColor='rgba(167,139,250,0.4)';this.style.color='#a78bfa'" onmouseout="if(!this.classList.contains('active')){this.style.background='rgba(167,139,250,0.08)';this.style.borderColor='rgba(167,139,250,0.2)';this.style.color='rgba(167,139,250,0.7)'}">All Day</button>
            </div>
            <label>Note</label>
            <input type="text" id="mNote" class="modal-input" placeholder="Optional note...">
        </div>
        <div class="modal-actions">
            <button class="modal-btn-confirm" onclick="saveShift()">CONFIRM</button>
            <button id="mSplitBtn" class="modal-btn-exchange" onclick="toggleSplitMode()" style="display:none;">&#9135; SPLIT</button>
            <button id="mExchangeBtn" class="modal-btn-exchange" onclick="startExchange()" style="display:none;">&#8646; EXCHANGE</button>
            <button id="mDeleteBtn" class="modal-btn-delete" onclick="deleteShift()" style="display:none;">DELETE</button>
            <button id="mSwapBtn" onclick="requestSwapFromModal()" style="display:none;background:rgba(33,150,243,0.12);border:1px solid rgba(33,150,243,0.4);color:#64b5f6;border-radius:6px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:0.78rem;">&#128260; Request swap</button>
            <button class="modal-btn-cancel" onclick="closeModal()">Cancel</button>
        </div>
        <!-- DoubleShift split section -->
        <div id="mSplitSection" style="display:none;padding:14px 24px 18px;border-top:1px solid #1e2030;background:rgba(91,127,166,0.04);">
            <div style="font-size:0.6rem;color:rgba(91,127,166,0.7);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;font-weight:600;">&#9135; Split Shift — Double Coverage</div>
            <label style="font-size:0.62rem;color:rgba(167,139,250,0.6);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px;font-weight:600;">Second Trader</label>
            <select id="mSplitName" class="modal-input" style="margin-bottom:10px;" onchange="_updateSplitPreview()">${allNames.map(n => '<option value="' + n + '">' + n + '</option>').join('')}</select>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <div style="flex:1;font-size:0.68rem;color:rgba(255,255,255,0.3);line-height:1.7;">
                    <span id="splitName1" style="color:rgba(167,139,250,0.7);font-weight:600;"></span> takes <strong id="splitHalf1" style="color:rgba(167,139,250,0.7);">--</strong><br>
                    <span id="splitName2" style="color:rgba(91,127,166,0.7);font-weight:600;"></span> takes <strong id="splitHalf2" style="color:rgba(91,127,166,0.7);">--</strong>
                </div>
                <button type="button" id="mSplitSwapBtn" onclick="toggleSplitOrder()" style="padding:6px 12px;background:rgba(91,127,166,0.1);color:#7ba3cc;border:1px solid rgba(91,127,166,0.3);border-radius:6px;cursor:pointer;font-size:0.7rem;font-weight:600;" onmouseover="this.style.background='rgba(91,127,166,0.2)'" onmouseout="this.style.background='rgba(91,127,166,0.1)'">&#8645; Swap</button>
            </div>
        </div>
        <!-- POINT 5: History / last edit -->
        <div id="mHistorySection" style="padding:0 24px 18px;border-top:1px solid #1e2030;background:rgba(0,0,0,0.15);">
            <div style="font-size:0.6rem;color:rgba(167,139,250,0.4);text-transform:uppercase;letter-spacing:1.5px;margin-top:14px;margin-bottom:8px;font-weight:600;">Recent Activity</div>
            <div id="mHistoryList" style="font-size:0.72rem;color:rgba(255,255,255,0.35);line-height:1.9;">
                <span style="color:rgba(255,255,255,0.15);">Loading...</span>
            </div>
        </div>
    </div>
</div>

<!-- POINT 2: Exchange modal -->
<div id="exchangeModal">
    <div class="exchange-outer">
        <div class="exchange-header">
            <h2>&#8646; EXCHANGE SHIFT</h2>
            <button onclick="closeExchange()" style="background:none;border:none;color:#666;font-size:1.4rem;cursor:pointer;">&#10005;</button>
        </div>
        <div class="exchange-body">
            <div class="exchange-side">
                <h3>Your Shift</h3>
                <div class="exchange-card selected" id="exCard1">
                    <div class="exchange-card-title" id="exTitle1">-</div>
                    <div class="exchange-card-sub" id="exSub1">-</div>
                    <div class="exchange-card-time" id="exTime1">-</div>
                </div>
                <div style="font-size:0.75rem;color:#555;">Trader: <span id="exName1" style="color:#fff;"></span></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:center;padding:0 10px;font-size:2rem;color:#42a5f5;">&#8644;</div>
            <div class="exchange-side">
                <h3>Exchange With</h3>
                <div class="exchange-card" id="exCard2" style="cursor:pointer;" onclick="startPickingMode()">
                    <div class="exchange-card-title" id="exTitle2" style="color:#555;">&#128270; Click here to select a shift...</div>
                    <div class="exchange-card-sub" id="exSub2" style="color:#42a5f5;font-size:0.75rem;margin-top:6px;">Then click any shift on the timeline</div>
                    <div class="exchange-card-time" id="exTime2"></div>
                </div>
                <div style="font-size:0.75rem;color:#555;">Trader: <span id="exName2" style="color:#fff;"></span></div>
            </div>
        </div>
        <div class="exchange-footer">
            <button class="exchange-cancel-btn" onclick="closeExchange()">Cancel</button>
            <button class="exchange-confirm-btn" id="exConfirmBtn" onclick="confirmExchange()" disabled style="opacity:0.4;">CONFIRM EXCHANGE</button>
        </div>
    </div>
</div>

<!-- Picking banner -->
<div class="picking-banner">&#128293; Click on any shift to select it for exchange — or press ESC to cancel</div>

<!-- Sync modal -->
<div id="syncModal" style="display:none;position:fixed;z-index:2000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);">
    <div style="background:#1a1a1a;margin:8% auto;border-radius:12px;width:420px;color:#eee;box-shadow:0 24px 64px rgba(0,0,0,0.7);border:1px solid #333;overflow:hidden;">
        <div style="padding:20px 24px 14px;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-family:'Oswald';font-size:1.1rem;color:#a78bfa;letter-spacing:1px;">&#128260; SYNC WITH SCHEDULE</span>
            <button onclick="closeSyncModal()" style="background:none;border:none;color:#666;font-size:1.3rem;cursor:pointer;">&#10005;</button>
        </div>
        <div style="padding:20px 24px;">
            <label style="font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:8px;">Select schedule sheet</label>
            <select id="syncSheetSelect" style="width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:6px;font-size:0.9rem;margin-bottom:20px;">
                <option value="">Loading...</option>
            </select>
            <div style="display:flex;gap:10px;">
                <button onclick="confirmSync()" style="flex:1;padding:12px;background:#a78bfa;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';font-size:1rem;cursor:pointer;letter-spacing:1px;">SYNC</button>
                <button onclick="closeSyncModal()" style="padding:12px 20px;background:#222;color:#888;border:none;border-radius:6px;cursor:pointer;">Cancel</button>
            </div>
        </div>
    </div>
</div>

<!-- AI Generator modal -->
<div id="aiGenModal" style="display:none;position:fixed;z-index:2000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);">
    <div style="background:#1a1a1a;margin:5% auto;border-radius:12px;width:680px;max-width:96vw;max-height:88vh;color:#eee;box-shadow:0 24px 64px rgba(0,0,0,0.7);border:1px solid #333;overflow:hidden;display:flex;flex-direction:column;">
        <div style="padding:20px 24px 14px;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
            <span style="font-family:'Oswald';font-size:1.1rem;color:#7ba3cc;letter-spacing:1px;">&#129302; AI SCHEDULE GENERATOR</span>
            <button onclick="closeAIGenModal()" style="background:none;border:none;color:#666;font-size:1.3rem;cursor:pointer;">&#10005;</button>
        </div>
        <div style="padding:20px 24px;overflow-y:auto;flex:1;">

            <div id="aiGenStep1">
                <label style="font-size:0.72rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px;">Month</label>
                <select id="aiGenMonth" style="width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:6px;font-size:0.9rem;margin-bottom:14px;"><option value="">Loading sheets...</option></select>

                <label style="font-size:0.72rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px;">Product</label>
                <select id="aiGenProduct" style="width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:6px;font-size:0.9rem;margin-bottom:14px;"></select>

                <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;color:#aaa;cursor:pointer;margin-bottom:18px;"><input type="checkbox" id="aiGenApc" style="width:16px;height:16px;cursor:pointer;accent-color:#7ba3cc;">Allow partial coverage</label>

                <div style="background:rgba(91,127,166,0.06);border-left:3px solid #7ba3cc;padding:10px 14px;border-radius:4px;margin-bottom:18px;font-size:0.78rem;color:#aaa;line-height:1.5;">Claude generates a plan based on peopleHierarchy, productCoverage and Capabilities. The output passes through the H1-H8 validator. Cost about 0.30 USD per product, takes 30-90s.</div>

                <div style="display:flex;gap:10px;">
                    <button onclick="aiGenRun()" id="aiGenRunBtn" style="flex:1;padding:12px;background:#7ba3cc;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';font-size:1rem;cursor:pointer;letter-spacing:1px;">&#9889; GENERATE</button>
                    <button onclick="aiGenBatch()" id="aiGenBatchBtn" style="flex:1;padding:12px;background:#ff9800;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';font-size:1rem;cursor:pointer;letter-spacing:1px;">&#127895; GENERATE ALL</button>
                    <button onclick="closeAIGenModal()" style="padding:12px 20px;background:#222;color:#888;border:none;border-radius:6px;cursor:pointer;">Cancel</button>
                </div>
            </div>

            <div id="aiGenStep2" style="display:none;text-align:center;padding:40px 20px;">
                <div style="display:inline-block;width:50px;height:50px;border:4px solid #333;border-top-color:#7ba3cc;border-radius:50%;animation:aiGenSpin 0.9s linear infinite;margin-bottom:18px;"></div>
                <div style="color:#7ba3cc;font-family:'Oswald';font-size:1.1rem;letter-spacing:1px;">GENERATING SCHEDULE...</div>
                <div id="aiGenProgress" style="color:#666;margin-top:8px;font-size:0.85rem;">Calling Claude API, this takes 30-90 seconds...</div>
            </div>

            <div id="aiGenStep3" style="display:none;">
                <div id="aiGenSummary" style="margin-bottom:16px;"></div>
                <div id="aiGenValidation" style="margin-bottom:14px;"></div>
                <div id="aiGenNotes" style="margin-bottom:14px;"></div>
                <details style="margin-bottom:14px;"><summary style="cursor:pointer;color:#7ba3cc;font-size:0.82rem;padding:6px 0;">Show shifts preview</summary><div id="aiGenShiftsPreview" style="max-height:220px;overflow-y:auto;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px;margin-top:6px;font-size:0.78rem;font-family:monospace;"></div></details>
                <div id="aiGenCommitResult" style="margin-bottom:14px;"></div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                    <button onclick="aiGenCommit(false)" id="aiGenCommitBtn" style="flex:1;min-width:140px;padding:12px;background:#4caf50;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';font-size:0.95rem;cursor:pointer;letter-spacing:1px;">&#9989; COMMIT TO SHEET</button>
                    <button onclick="aiGenCommit(true)" id="aiGenOverwriteBtn" style="flex:1;min-width:140px;padding:12px;background:#ff9800;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';font-size:0.95rem;cursor:pointer;letter-spacing:1px;">&#9888; COMMIT + OVERWRITE</button>
                    <button onclick="aiGenReset()" style="padding:12px 20px;background:#222;color:#888;border:none;border-radius:6px;cursor:pointer;">New Run</button>
                    <button onclick="closeAIGenModal()" style="padding:12px 20px;background:#222;color:#888;border:none;border-radius:6px;cursor:pointer;">Close</button>
                </div>
            </div>

        </div>
    </div>
</div>
<style>@keyframes aiGenSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>

<!-- CSV Export modal -->
<div id="exportModal" style="display:none;position:fixed;z-index:2000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);">
    <div style="background:#1a1a1a;margin:5% auto;border-radius:12px;width:460px;max-width:96vw;color:#eee;box-shadow:0 24px 64px rgba(0,0,0,0.7);border:1px solid #333;overflow:hidden;">
        <div style="padding:20px 24px 14px;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-family:'Oswald';font-size:1.1rem;color:#4caf50;letter-spacing:1px;">&#128190; EXPORT CSV</span>
            <button onclick="closeExportModal()" style="background:none;border:none;color:#666;font-size:1.3rem;cursor:pointer;">&#10005;</button>
        </div>
        <div style="padding:16px 24px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <label style="font-size:0.72rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Select traders to export</label>
                <div style="display:flex;gap:8px;">
                    <button onclick="document.querySelectorAll('.export-cb').forEach(c=>c.checked=true);updateExportCount()" style="padding:4px 10px;background:rgba(76,175,80,0.1);color:#66bb6a;border:1px solid rgba(76,175,80,0.25);border-radius:5px;cursor:pointer;font-size:0.65rem;font-weight:600;">ALL</button>
                    <button onclick="document.querySelectorAll('.export-cb').forEach(c=>c.checked=false);updateExportCount()" style="padding:4px 10px;background:rgba(244,67,54,0.08);color:#e57373;border:1px solid rgba(244,67,54,0.2);border-radius:5px;cursor:pointer;font-size:0.65rem;font-weight:600;">NONE</button>
                </div>
            </div>
            <div id="exportNamesList" style="max-height:320px;overflow-y:auto;background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:6px;">
                ${allNames.map(n => {
                    const c = personColors[n] || '#888';
                    return '<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;border-radius:4px;font-size:0.82rem;color:#c8d0e0;" onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'none\'">'
                        + '<input type="checkbox" class="export-cb" value="' + n + '" onchange="updateExportCount()" style="accent-color:' + c + ';width:15px;height:15px;cursor:pointer;">'
                        + '<span style="width:8px;height:8px;border-radius:50%;background:' + c + ';flex-shrink:0;"></span>'
                        + n + '</label>';
                }).join('')}
            </div>
            <div style="font-size:0.68rem;color:#555;margin-top:8px;" id="exportCountLabel">0 selected</div>
            <div style="display:flex;gap:10px;margin-top:14px;">
                <button onclick="confirmExportCSV()" style="flex:1;padding:12px;background:#4caf50;color:#000;border:none;border-radius:6px;font-weight:700;font-family:'Oswald';font-size:1rem;cursor:pointer;letter-spacing:1px;">DOWNLOAD</button>
                <button onclick="closeExportModal()" style="padding:12px 20px;background:#222;color:#888;border:none;border-radius:6px;cursor:pointer;">Cancel</button>
            </div>
        </div>
    </div>
</div>

<!-- Confirm dialog -->
<div id="confirmDialog">
    <div class="confirm-box">
        <h3 id="confirmTitle">Are you sure?</h3>
        <p id="confirmText"></p>
        <div class="confirm-btns">
            <button class="confirm-yes" id="confirmYesBtn">Yes</button>
            <button class="confirm-no" onclick="closeConfirm()">No</button>
        </div>
    </div>
</div>

<!-- Slack Settings Modal -->
<div id="slackModal" style="display:none;position:fixed;z-index:2000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);">
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#12131a;border:1px solid #1e2030;border-radius:14px;width:380px;max-height:80vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
        <div style="padding:18px 24px;border-bottom:1px solid #1e2030;display:flex;align-items:center;justify-content:space-between;">
            <div>
                <div style="font-size:0.9rem;font-weight:700;color:#e8eaf0;">&#128276; Slack Notifications</div>
                <div style="font-size:0.62rem;color:#3a4050;margin-top:2px;">Subscribe to shift changes for traders</div>
            </div>
            <button onclick="closeSlackSettings()" style="background:none;border:none;color:#3a4050;font-size:1.2rem;cursor:pointer;">&times;</button>
        </div>
        <div id="slackSubsList" style="padding:12px 24px;max-height:55vh;overflow-y:auto;"></div>
        <div style="padding:12px 24px 18px;border-top:1px solid #1e2030;text-align:right;">
            <button onclick="closeSlackSettings()" style="padding:8px 20px;background:rgba(167,139,250,0.1);color:#a78bfa;border:1px solid rgba(167,139,250,0.25);border-radius:8px;cursor:pointer;font-size:0.75rem;font-weight:700;letter-spacing:0.5px;">DONE</button>
        </div>
    </div>
</div>

<!-- POINT 1: Mobile overlay -->
<div class="mobile-overlay" id="mobileOverlay" onclick="toggleMobileMenu()"></div>

<!-- Shift hover tooltip -->
<div id="shiftTooltip" style="display:none;position:fixed;z-index:3000;pointer-events:none;max-width:260px;">
    <div style="background:#12131a;border:1px solid #2a2d3e;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.7);overflow:hidden;">
        <div id="ttHeader" style="padding:10px 14px 8px;border-bottom:1px solid #1e2030;"></div>
        <div style="padding:10px 14px 12px;">
            <div id="ttTime" style="font-size:0.82rem;font-weight:700;color:#c8d0e0;margin-bottom:6px;"></div>
            <div id="ttProduct" style="font-size:0.75rem;color:#8892a4;margin-bottom:4px;"></div>
            <div id="ttNote" style="font-size:0.72rem;color:#555;font-style:italic;"></div>
            <div id="ttCrew" style="display:none;margin-top:6px;border-top:1px solid #1e2030;padding-top:6px;"></div>
        </div>
    </div>
</div>

<!-- Color Picker modal -->
<div id="colorPickerModal" style="display:none;position:fixed;z-index:2100;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);">
    <div style="background:#12131a;margin:4% auto;border-radius:14px;width:480px;max-width:96vw;color:#eee;box-shadow:0 32px 80px rgba(0,0,0,0.8);border:1px solid #1e2030;overflow:hidden;">
        <div style="padding:20px 24px 14px;border-bottom:1px solid #1e2030;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-family:'Oswald';font-size:1.1rem;color:#a78bfa;letter-spacing:1px;">&#127912; COLOR SETTINGS</span>
            <button onclick="closeColorPicker()" style="background:none;border:none;color:#666;font-size:1.3rem;cursor:pointer;">&#10005;</button>
        </div>
        <div style="padding:16px 24px;">
            <input type="text" id="colorSearch" placeholder="Search trader..." oninput="renderColorList()" style="width:100%;padding:8px 10px;background:#0a0b0f;border:1px solid #1e2030;color:#ccc;border-radius:6px;margin-bottom:12px;box-sizing:border-box;font-size:0.8rem;outline:none;">
            <div id="colorList" style="max-height:400px;overflow-y:auto;"></div>
            <div style="display:flex;gap:10px;margin-top:14px;">
                <button onclick="resetAllColors()" style="padding:8px 16px;background:rgba(244,67,54,0.08);color:#e57373;border:1px solid rgba(244,67,54,0.2);border-radius:6px;cursor:pointer;font-size:0.72rem;font-weight:600;">RESET ALL</button>
                <button onclick="closeColorPicker()" style="flex:1;padding:8px;background:rgba(167,139,250,0.1);color:#a78bfa;border:1px solid rgba(167,139,250,0.25);border-radius:6px;cursor:pointer;font-weight:700;font-family:'Oswald';letter-spacing:1px;">DONE</button>
            </div>
        </div>
    </div>
</div>

<!-- Timezone toggle -->
<button class="tz-toggle-btn" id="tzToggle" onclick="toggleTimezone()">
    &#127757; <span id="tzLabel">EUROPE</span>
    <span class="tz-badge" id="tzBadge">-&gt; LIMA</span>
</button>

<script>
    const pColors = ${personColorsJSON};
    const pRoles = {}; ${personRolesJS}
    const tColors = {}; ${tradingColorsJS}
    ${productColorsClientJS}
    const _crewMap = ${JSON.stringify(crewMap)};
    window._productList = ${JSON.stringify(productMapping.map(p => p.name))};
    window._me = ${JSON.stringify(req.user.jmeno)};
    window._isMgr = ${req.user.role === 'Admin' ? 'true' : 'false'};
    window._myProducts = ${JSON.stringify([...new Set(allShifts.filter(s => s.Name === req.user.jmeno).map(s => s.Product).filter(Boolean))])};

    // SHOW ALL
    // My-shifts presets — TOGGLE: click shows, click again hides (clears the preset)
    function _mineState(){
        var an=Array.from(document.querySelectorAll('.user-item.active')).map(function(e){return (e.dataset.name||'').trim();});
        var ap=Array.from(document.querySelectorAll('.product-selector.active')).map(function(e){return (e.dataset.productName||'').trim();});
        var mp=window._myProducts||[];
        var meOnly = an.length===1 && an[0]===window._me;
        return { mineOn: meOnly && ap.length===0,
                 plusOn: meOnly && mp.length>0 && ap.length===mp.length && mp.every(function(p){return ap.indexOf(p)>=0;}) };
    }
    function refreshMineBtns(){
        var s=_mineState();
        var b1=document.getElementById('mineBtn'); if(b1) b1.style.background = s.mineOn?'rgba(167,139,250,0.34)':'rgba(167,139,250,0.10)';
        var b2=document.getElementById('minePlusBtn'); if(b2) b2.style.background = s.plusOn?'rgba(34,211,238,0.34)':'rgba(34,211,238,0.10)';
    }
    function showMine(withProducts){
        var st=_mineState();
        var already = withProducts ? st.plusOn : st.mineOn;
        var sb=document.getElementById('showAllBtn'); if(sb) sb.classList.remove('active');
        document.querySelectorAll('.user-item.active,.product-selector.active,.trading-cat-item.active').forEach(function(i){ i.classList.remove('active'); });
        if(!already){
            document.querySelectorAll('.user-item').forEach(function(i){ if((i.dataset.name||'').trim()===window._me) i.classList.add('active'); });
            if(withProducts){
                var mp=window._myProducts||[];
                document.querySelectorAll('.product-selector').forEach(function(s){ if(mp.indexOf((s.dataset.productName||'').trim())>=0) s.classList.add('active'); });
            }
        }
        applyAllFilters(); saveSelection();
    }
    function showAllRows(el) {
        const on = el.classList.toggle('active');
        if (on) {
            document.querySelectorAll('.user-item.active,.product-selector.active,.trading-cat-item.active').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.user-row,.product-row').forEach(r => {
                r.classList.remove('hidden-row');
                r.classList.add('row-appearing');
                setTimeout(() => r.classList.remove('row-appearing'), 300);
            });
        } else {
            document.querySelectorAll('.user-row,.product-row').forEach(r => r.classList.add('hidden-row'));
        }
        restripeRows(); if(typeof refreshMineBtns==='function') refreshMineBtns();
    }

    function toggleTheme(){
        var isLight = document.documentElement.classList.toggle('theme-light');
        try{ localStorage.setItem('ygg_theme', isLight?'light':'dark'); }catch(e){}
        var b=document.getElementById('themeToggle'); if(b) b.textContent = isLight?'☾':'☀';
    }
    // ===== In-app notification bell (persistent; shows what changed while you were away) =====
    window._notifs = [];
    function escapeHtmlN(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function notifAgo(iso){ try{ var ms=Date.now()-new Date(iso).getTime(); var m=Math.floor(ms/60000); if(m<1)return 'just now'; if(m<60)return m+'m ago'; var h=Math.floor(m/60); if(h<24)return h+'h ago'; return Math.floor(h/24)+'d ago'; }catch(e){ return ''; } }
    function renderBellPanel(){
        var p=document.getElementById('bellPanel'); if(!p) return;
        var items=window._notifs||[];
        if(!items.length){ p.innerHTML='<div style="padding:16px;color:#8892a4;font-size:0.8rem;text-align:center;">No notifications</div>'; return; }
        var h='<div style="font-size:0.66rem;text-transform:uppercase;letter-spacing:1px;color:#8892a4;padding:6px 8px 8px;">Notifications</div>';
        items.forEach(function(n){ h+='<div style="padding:8px 10px;border-radius:7px;margin-bottom:3px;background:'+(n.read?'transparent':'rgba(167,139,250,0.12)')+';font-size:0.76rem;color:#c8d0e0;line-height:1.3;">'+escapeHtmlN(n.text)+'<div style="font-size:0.6rem;color:#6b7585;margin-top:3px;">'+notifAgo(n.createdAt)+'</div></div>'; });
        p.innerHTML=h;
    }
    function loadNotifs(){
        fetch('/api/notifications').then(function(r){return r.json();}).then(function(d){
            window._notifs=d.items||[];
            var b=document.getElementById('bellBadge');
            if(b){ if(d.unread>0){ b.textContent=d.unread>9?'9+':String(d.unread); b.style.display='block'; } else b.style.display='none'; }
            renderBellPanel();
        }).catch(function(){});
    }
    window.toggleBell=function(){
        var p=document.getElementById('bellPanel'); if(!p) return;
        if(p.style.display==='block'){ p.style.display='none'; return; }
        p.style.display='block'; renderBellPanel();
        if((window._notifs||[]).some(function(n){return !n.read;})){
            fetch('/api/notifications/read',{method:'POST'}).then(function(){
                var b=document.getElementById('bellBadge'); if(b) b.style.display='none';
                (window._notifs||[]).forEach(function(n){ n.read=true; });
            }).catch(function(){});
        }
    };
    document.addEventListener('click',function(e){ var p=document.getElementById('bellPanel'),b=document.getElementById('bellBtn'); if(p&&p.style.display==='block'&&!p.contains(e.target)&&b&&!b.contains(e.target)) p.style.display='none'; });
    loadNotifs(); setInterval(loadNotifs, 90000);

    // ===== Drag-to-reschedule — opt-in "Move mode"; timeline, your ManualShifts, same day, Europe tz =====
    (function(){
        var HOURPX=40, DAYPX=960, GRIDPX=6720, SNAP=0.25; // 15-min snap
        var moveMode=false, drag=null, justDragged=false, undoStack=[], redoStack=[];
        var st=document.createElement('style'); st.textContent='body.move-mode .shift-pill{cursor:grab;} body.move-mode .shift-pill:active{cursor:grabbing;}'; document.head.appendChild(st);
        function toH(t){ var a=(t||'0:0').split(':'); return (+a[0])+(+a[1])/60; }
        function hhmm(h){ var H=Math.floor(h+1e-9), M=Math.round((h-H)*60); if(M===60){H++;M=0;} return (H<10?'0':'')+H+':'+(M<10?'0':'')+M; }
        function tzOff(){ try{ return localStorage.getItem('ygg_tz')==='lima'?-6:0; }catch(e){ return 0; } }   // display offset: CET=0, Lima=-6
        function m2hhmm(mins){ mins=((Math.round(mins)%1440)+1440)%1440; var H=Math.floor(mins/60),M=mins%60; return (H<10?'0':'')+H+':'+(M<10?'0':'')+M; }
        function eligible(p){ return p && p.classList && p.classList.contains('shift-pill') && (p.dataset.sht||'')!=='' && (p.dataset.pillPart||'0')==='0' && p.dataset.tooltipProduct!=='Vacation' && p.dataset.tooltipProduct!=='RIP' && p.closest('.user-row') && p.closest('.row-grid-bg'); }
        function setUndoBtns(){ var u=document.getElementById('undoBtn'),r=document.getElementById('redoBtn'); if(u){ u.style.display=moveMode?'inline-block':'none'; u.style.opacity=undoStack.length?'1':'0.4'; } if(r){ r.style.display=moveMode?'inline-block':'none'; r.style.opacity=redoStack.length?'1':'0.4'; } }
        // Position a timeline pill exactly like the server render + tz toggle would. data-orig-* are CET; the display applies the tz offset.
        function placePill(p){
            var off=tzOff(), od=parseInt(p.dataset.origDay||'0',10)||0;
            var os=(p.dataset.origStart||'0:0').split(':'), oe=(p.dataset.origEnd||'0:0').split(':');
            var sm=(+os[0])*60+(+os[1])+off*60, em=(+oe[0])*60+(+oe[1])+off*60;
            var dOff=0; if(sm<0)dOff=-1; else if(sm>=1440)dOff=1;
            sm=((sm%1440)+1440)%1440; em=((em%1440)+1440)%1440;
            var nd=od+dOff; if(nd<0)nd=0; if(nd>6)nd=6;
            var sp=(sm/1440)*100, ep=(em/1440)*100, eff=(em===0?100:ep);
            var w=(eff>sp)?(eff-sp)/7:(100-sp)/7;
            p.style.left=((nd*100/7)+(sp/7))+'%'; p.style.width=Math.max(w,0.3)+'%';
            var t=p.querySelector('.pill-time'); if(t) t.textContent=m2hhmm(sm)+' - '+m2hhmm(em);
        }
        window.toggleMoveMode=function(){ moveMode=!moveMode; try{localStorage.setItem('ygg_move',moveMode?'1':'0');}catch(e){} document.body.classList.toggle('move-mode',moveMode); var b=document.getElementById('moveModeBtn'); if(b) b.style.color=moveMode?'#22d3ee':'#5b7fa6'; setUndoBtns(); toast(moveMode?'Move mode ON — drag your shifts to reschedule. Ctrl+Z = undo.':'Move mode OFF'); };
        document.addEventListener('mousedown',function(e){
            if(!moveMode||e.button!==0) return;
            var p=e.target.closest&&e.target.closest('.shift-pill'); if(!p||!eligible(p)) return;
            var dur=toH(p.dataset.origEnd)-toH(p.dataset.origStart); if(!(dur>0)) return;
            e.preventDefault();
            drag={ p:p, x0:e.clientX, l0:p.offsetLeft, w:p.offsetWidth, dur:dur, day:parseInt(p.dataset.origDay||'0',10), moved:false };
            p.style.zIndex='200'; p.style.opacity='0.85';
        },true);
        document.addEventListener('mousemove',function(e){
            if(!drag) return;
            var dx=e.clientX-drag.x0; if(Math.abs(dx)>4) drag.moved=true;
            var lo=drag.day*DAYPX, hi=(drag.day+1)*DAYPX-drag.w;
            drag.p.style.left=Math.max(lo,Math.min(hi,drag.l0+dx))+'px';
        });
        document.addEventListener('mouseup',function(){
            if(!drag) return; var d=drag; drag=null;
            d.p.style.zIndex=''; d.p.style.opacity='';
            if(!d.moved){ placePill(d.p); return; }
            justDragged=true; setTimeout(function(){justDragged=false;},60);
            var off=tzOff(), nl=parseFloat(d.p.style.left)||d.l0;
            var dispMins=(nl-d.day*DAYPX)/HOURPX*60;                                    // displayed (current tz) start mins within the day-column
            var storedMins=Math.round((dispMins-off*60)/(SNAP*60))*(SNAP*60);           // -> CET, snapped to 15 min
            storedMins=Math.max(0, Math.min(1440-d.dur*60, storedMins));                // keep CET shift within the day (no overnight / no date cross)
            var before={start:d.p.dataset.origStart,end:d.p.dataset.origEnd};
            var after={start:m2hhmm(storedMins),end:m2hhmm(storedMins+d.dur*60)};
            if(after.start===before.start && after.end===before.end){ placePill(d.p); return; }
            applyMove(d.p,before,after,true);
        });
        function applyMove(p,before,after,push){
            var nm=p.dataset.snm||p.dataset.person||'';
            var body={ id:p.dataset.sid||'', originalName:nm, originalDate:p.dataset.shiftDate, originalStart:before.start, name:nm, date:p.dataset.shiftDate, start:after.start, end:after.end, product:p.dataset.tooltipProduct||'', trading:p.dataset.tooltipTrading||'', note:p.dataset.tooltipNote||'' };
            // Editing a Schedule (non-manual) shift -> send override key so the server creates a ManualShift override hiding the Schedule slot
            if((p.dataset.sht||'')!=='ManualShifts'){ body.overrideKey = nm+'|'+p.dataset.shiftDate+'|'+(p.dataset.tooltipProduct||'')+'|'+before.start+'|'+before.end; }
            fetch('/update-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(x){
                if(!x.ok||(x.j&&x.j.error)){ placePill(p); toast('Move failed: '+((x.j&&x.j.error)||'?')); return; }
                p.dataset.origStart=after.start; p.dataset.origEnd=after.end;
                if(x.j && x.j.created && x.j.id){ p.dataset.sht='ManualShifts'; p.dataset.sid=x.j.id; } // now a manual override; further moves go by id
                placePill(p);
                if(push){ undoStack.push({p:p,before:before,after:after}); redoStack=[]; }
                setUndoBtns(); toast('Moved to '+after.start+'–'+after.end+' CET');
            }).catch(function(err){ placePill(p); toast('Move failed: '+err.message); });
        }
        window.dragUndo=function(){ var m=undoStack.pop(); if(!m){ toast('Nothing to undo'); return; } redoStack.push(m); applyMove(m.p,m.after,m.before,false); };
        window.dragRedo=function(){ var m=redoStack.pop(); if(!m){ toast('Nothing to redo'); return; } undoStack.push(m); applyMove(m.p,m.before,m.after,false); };
        document.addEventListener('keydown',function(e){ if(!moveMode) return; var k=(e.key||'').toLowerCase(); if((e.ctrlKey||e.metaKey)&&k==='z'){ e.preventDefault(); dragUndo(); } else if((e.ctrlKey||e.metaKey)&&k==='y'){ e.preventDefault(); dragRedo(); } });
        document.addEventListener('click',function(e){ if(justDragged){ var p=e.target.closest&&e.target.closest('.shift-pill'); if(p){ e.stopPropagation(); e.preventDefault(); } } },true);
        // Move mode defaults ON + is remembered, so dragging works out of the box (✥ toggles it off)
        moveMode=(function(){try{return localStorage.getItem('ygg_move')!=='0';}catch(e){return true;}})();
        document.body.classList.toggle('move-mode',moveMode);
        (function(){ var b=document.getElementById('moveModeBtn'); if(b) b.style.color=moveMode?'#22d3ee':'#5b7fa6'; setUndoBtns(); })();
    })();
    // Zebra striping over VISIBLE rows only (so it stays alternating after sidebar filtering)
    function restripeRows() {
        let vis = 0;
        document.querySelectorAll('.timeline-row').forEach(r => {
            if (r.classList.contains('hidden-row')) { r.classList.remove('zeb'); return; }
            r.classList.toggle('zeb', vis % 2 === 1);
            vis++;
        });
    }
    function applyAllFilters() {
        const aN = Array.from(document.querySelectorAll('.user-item.active')).map(e => e.dataset.name.trim());
        const aP = Array.from(document.querySelectorAll('.product-selector.active')).map(e => e.dataset.productName.trim());

        // Pokud neni nic vybrano, schovej vse
        if (aN.length === 0 && aP.length === 0) {
            document.querySelectorAll('.user-row, .product-row').forEach(r => r.classList.add('hidden-row'));
            restripeRows(); if(typeof refreshMineBtns==='function') refreshMineBtns();
            return;
        }

        // Unified pass: elements with both user-row+product-row (week/list/agenda pills)
        // are shown if EITHER their person OR product matches — prevents double-loop conflict.
        document.querySelectorAll('.user-row, .product-row').forEach(r => {
            let show = false;
            if (r.classList.contains('user-row')) {
                const rowName = (r.dataset.name || '').trim();
                if (aN.length > 0 && aN.some(n => n === rowName)) show = true;
            }
            if (!show && r.classList.contains('product-row')) {
                const rowProd = (r.dataset.productRow || '').trim();
                if (aP.length > 0 && aP.some(p => p === rowProd)) show = true;
            }
            const wasH = r.classList.contains('hidden-row');
            r.classList.toggle('hidden-row', !show);
            if (wasH && show) { r.classList.add('row-appearing'); setTimeout(() => r.classList.remove('row-appearing'), 300); }
        });
        restripeRows(); if(typeof refreshMineBtns==='function') refreshMineBtns();
    }

    function saveSelection() {
        const names = Array.from(document.querySelectorAll('.user-item.active')).map(e => e.dataset.name);
        const prods = Array.from(document.querySelectorAll('.product-selector.active')).map(e => e.dataset.productName);
        localStorage.setItem('ygg_sel_names', names.join('||'));
        localStorage.setItem('ygg_sel_prods', prods.join('||'));
    }
    function toggleSelect(n,el){ document.getElementById('showAllBtn').classList.remove('active'); el.classList.toggle('active'); applyAllFilters(); saveSelection(); }
    function toggleProduct(p,el){ document.getElementById('showAllBtn').classList.remove('active'); el.classList.toggle('active'); applyAllFilters(); saveSelection(); }
    function filterByTrading(c,el){
        document.getElementById('showAllBtn').classList.remove('active');
        el.classList.toggle('active');
        const on = el.classList.contains('active');
        document.querySelectorAll('.product-selector[data-trading="' + c + '"]').forEach(s => { if(on) s.classList.add('active'); else s.classList.remove('active'); });
        applyAllFilters();
    }

    function filterWarriors(){
        const q = document.getElementById('warriorSearch').value.toLowerCase();
        document.querySelectorAll('.user-item').forEach(i => i.style.display = i.innerText.toLowerCase().includes(q)?'':'none');
    }

    function toggleSection(id, titleEl) {
        const grp = document.getElementById(id);
        if (!grp) return;
        const collapsed = grp.style.display === 'none';
        grp.style.display = collapsed ? '' : 'none';
        const chevron = titleEl.querySelector('.section-chevron');
        if (chevron) chevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
        // persist state
        try {
            const state = JSON.parse(localStorage.getItem('ygg_grp_collapse') || '{}');
            state[id] = !collapsed;
            localStorage.setItem('ygg_grp_collapse', JSON.stringify(state));
        } catch(e) {}
    }

    // Restore collapse state on load
    (function() {
        try {
            const state = JSON.parse(localStorage.getItem('ygg_grp_collapse') || '{}');
            Object.keys(state).forEach(id => {
                if (state[id]) {
                    const grp = document.getElementById(id);
                    const titleEl = grp && grp.previousElementSibling;
                    if (grp) grp.style.display = 'none';
                    if (titleEl) {
                        const chevron = titleEl.querySelector('.section-chevron');
                        if (chevron) chevron.style.transform = 'rotate(-90deg)';
                    }
                }
            });
        } catch(e) {}
    })();

    function changeDate(off){
        saveSelection();
        const p = new URLSearchParams(window.location.search);
        let d = p.get('date') ? new Date(p.get('date')) : new Date();
        d.setDate(d.getDate()+off);
        window.location.href='/dashboard?view=${view}&date='+d.toISOString().split('T')[0];
    }
    function switchView(v){ saveSelection(); localStorage.setItem('ygg_view',v); const p=new URLSearchParams(window.location.search); p.set('view',v); window.location.href='/dashboard?'+p.toString(); }

    // POINT 1: MODAL
    function openViewModal(name,date,start,end,product,note,trading,personColor,prodColor,sheetTitle,row,col,id,ev){
        // Phase 5: Ctrl/Cmd+click = select for bulk delete (does not open modal)
        var _ev = ev || window.event;
        if (_ev && (_ev.ctrlKey || _ev.metaKey) && typeof window.yggBulkClick === 'function') {
            window.yggBulkClick(name, sheetTitle, id, _ev.currentTarget || _ev.target);
            return;
        }
        // If we are in picking mode, capture this shift for exchange
        if (_pickingMode && typeof pickShiftForExchange === 'function') {
            pickShiftForExchange(name,date,start,end,product,note,trading,personColor,prodColor,sheetTitle,row,col);
            return;
        }
        const hdr = document.getElementById('mHeader');
        hdr.style.background = 'linear-gradient(135deg,'+personColor+'22 0%,'+prodColor+'22 100%)';
        hdr.style.borderBottomColor = prodColor;

        const ptEl = document.getElementById('mProductDisplay');
        ptEl.textContent = product;
        ptEl.style.color = prodColor;

        const pnEl = document.getElementById('mPersonDisplay');
        pnEl.textContent = name;
        pnEl.style.color = personColor;

        const rb = document.getElementById('mRoleBadge');
        rb.textContent = pRoles[name]||'';
        rb.style.background = personColor+'33';
        rb.style.color = personColor;

        const dObj = new Date(date);
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        document.getElementById('mDateDisplay').textContent = days[dObj.getDay()]+' '+dObj.getDate()+'.'+(dObj.getMonth()+1)+'.'+dObj.getFullYear();
        document.getElementById('mTimeDisplay').textContent = start+' - '+end;

        const tr = document.getElementById('mTagsRow');
        const tc = pColorsProduct[product] || tColors[trading] || '#555';
        tr.innerHTML = '<span class="modal-tag" style="background:'+tc+'22;color:'+tc+';border:1px solid '+tc+'44;">'+trading+'</span>'
                     + (note?'<span class="modal-tag" style="background:#222;color:#ccc;">'+note+'</span>':'');

        // Crew: show other people on the same shift
        const crewKey = date+'|'+product+'|'+start+'|'+end;
        const crewAll = _crewMap[crewKey] || [];
        const crewOthers = crewAll.filter(n => n !== name);
        const crewEl = document.getElementById('mCrewDisplay');
        if (crewOthers.length > 0) {
            crewEl.innerHTML = '<div style="font-size:0.65rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Also on this shift</div>'
                + crewOthers.map(c => {
                    const cc = pColors[c] || '#888';
                    return '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;background:'+cc+'22;border:1px solid '+cc+'44;margin:2px;">'
                         + '<span style="width:8px;height:8px;border-radius:50%;background:'+cc+';"></span>'
                         + '<span style="font-size:0.75rem;color:'+cc+';font-weight:600;">'+c+'</span>'
                         + '</span>';
                }).join('');
            crewEl.style.display = 'block';
        } else {
            crewEl.style.display = 'none';
        }

        // Store source data for delete + exchange
        // row can be 0 (first row) - so we check !== undefined
        const hasSource = (sheetTitle !== undefined && sheetTitle !== null && sheetTitle !== '');
        _currentShiftSource = {
            name:       name,
            date:       date,
            product:    product,
            start:      start,
            end:        end,
            trading:    trading,
            note:       note || '',
            sheetTitle: sheetTitle || '',
            row:        (row !== undefined && row !== null) ? parseInt(row) : -1,
            col:        (col !== undefined && col !== null) ? parseInt(col) : -1,
            id:         (id !== undefined && id !== null) ? id : ''
        };
        // DELETE and EXCHANGE always visible in edit mode
        document.getElementById('mDeleteBtn').style.display = 'block';
        document.getElementById('mExchangeBtn').style.display = 'block';
        document.getElementById('mSplitBtn').style.display = 'block';
        // Request swap - only for own shift (not RIP/Vacation)
        var _swBtn = document.getElementById('mSwapBtn');
        if (_swBtn) _swBtn.style.display = ((name === window._me || window._isMgr) && product !== 'Vacation' && product !== 'RIP') ? 'block' : 'none';
        // Populate extra traders from crew
        const crewKey2 = date+'|'+product+'|'+start+'|'+end;
        const crewAll2 = _crewMap[crewKey2] || [];
        _extraTraders = crewAll2.filter(n => n !== name);
        renderExtraTraders();
        document.getElementById('mMode').value='edit';
        document.getElementById('oName').value=name;
        document.getElementById('oDate').value=date;
        document.getElementById('oStart').value=start;
        document.getElementById('mName').value=name;
        document.getElementById('mDate').value=date;
        dpSetText('dp1',date);
        document.getElementById('mStart').value=start;
        document.getElementById('mEnd').value=end;
        document.getElementById('mTrading').value=trading;
        updateProductDropdown();
        document.getElementById('mProd').value=product;
        document.getElementById('mNote').value=note||'';
        // Reset All Day button
        const adBtn=document.getElementById('mAllDayBtn');
        adBtn.classList.remove('active');
        adBtn.style.background='rgba(167,139,250,0.08)';
        adBtn.style.borderColor='rgba(167,139,250,0.2)';
        adBtn.style.color='rgba(167,139,250,0.7)';
        document.getElementById('mStart').readOnly=false;
        document.getElementById('mStart').style.opacity='1';
        document.getElementById('mEnd').readOnly=false;
        document.getElementById('mEnd').style.opacity='1';
        // Hide multi-day in edit mode
        document.getElementById('mMultiDayBtn').style.display='none';
        document.getElementById('dpWrap2').style.display='none';
        document.getElementById('mDateToLabel').style.display='none';
        // Auto-detect all-day shifts
        if(start==='00:00' && (end==='23:59'||end==='24:00')){
            adBtn.classList.add('active');
            adBtn.style.background='rgba(167,139,250,0.2)';
            adBtn.style.borderColor='rgba(167,139,250,0.5)';
            adBtn.style.color='#a78bfa';
            document.getElementById('mStart').readOnly=true;
            document.getElementById('mStart').style.opacity='0.5';
            document.getElementById('mEnd').readOnly=true;
            document.getElementById('mEnd').style.opacity='0.5';
        }
        document.getElementById('modal').style.display='block';

        // POINT 5: Load shift history
        const histList = document.getElementById('mHistoryList');
        histList.innerHTML = '<span style="color:#444;">Loading...</span>';
        function timeAgo(isoStr) {
            if (!isoStr) return '';
            const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
            if (diff < 60) return diff + 's ago';
            if (diff < 3600) return Math.floor(diff/60) + 'm ago';
            if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
            return Math.floor(diff/86400) + 'd ago';
        }
        fetch('/api/shift-history?name=' + encodeURIComponent(name) + '&product=' + encodeURIComponent(product) + '&date=' + encodeURIComponent(date))
            .then(r => r.json())
            .then(data => {
                let html = '';
                if (data.created) {
                    html += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">'
                        + '<span style="color:#555;font-size:0.68rem;">Created by</span>'
                        + '<span style="color:#a78bfa;font-weight:600;font-size:0.72rem;">' + data.created.by + '</span>'
                        + '<span style="color:#444;font-size:0.65rem;">' + timeAgo(data.created.at) + '</span>'
                        + '</div>';
                } else {
                    html += '<div style="color:#555;font-size:0.68rem;margin-bottom:4px;">From schedule</div>';
                }
                if (data.edits && data.edits.length) {
                    data.edits.slice().reverse().forEach((e, i) => {
                        html += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px;">'
                            + '<span style="color:#555;font-size:0.68rem;">' + (i === 0 ? 'Last edit by' : 'Edit by') + '</span>'
                            + '<span style="color:#42a5f5;font-weight:600;font-size:0.72rem;">' + e.by + '</span>'
                            + '<span style="color:#444;font-size:0.65rem;">' + timeAgo(e.at) + '</span>'
                            + '</div>';
                    });
                }
                histList.innerHTML = html || '<span style="color:#333;">No history</span>';
            })
            .catch(() => { histList.innerHTML = '<span style="color:#333;">-</span>'; });
    }

    function openAddModal(){
        const hdr = document.getElementById('mHeader');
        hdr.style.background='#111';
        hdr.style.borderBottomColor='#a78bfa';
        document.getElementById('mProductDisplay').textContent='New Shift';
        document.getElementById('mProductDisplay').style.color='#a78bfa';
        document.getElementById('mPersonDisplay').textContent='';
        document.getElementById('mRoleBadge').textContent='';
        document.getElementById('mDateDisplay').textContent='-';
        document.getElementById('mTimeDisplay').textContent='-';
        document.getElementById('mTagsRow').innerHTML='';
        _currentShiftSource = null;
        document.getElementById('mDeleteBtn').style.display = 'none';
        document.getElementById('mExchangeBtn').style.display = 'none';
        document.getElementById('mSplitBtn').style.display = 'none';
        document.getElementById('mSplitSection').style.display = 'none';
        _extraTraders = []; renderExtraTraders();
        document.getElementById('mMode').value='add';
        updateProductDropdown();
        // Default to currently viewed date in dashboard, not today
        const defDate = _viewDate ? new Date(_viewDate) : new Date();
        const defVal = defDate.getFullYear()+'-'+String(defDate.getMonth()+1).padStart(2,'0')+'-'+String(defDate.getDate()).padStart(2,'0');
        document.getElementById('mDate').value=defVal;
        dpSetText('dp1',defVal);
        document.getElementById('mStart').value='';
        document.getElementById('mEnd').value='';
        document.getElementById('mProd').value='';
        document.getElementById('mNote').value='';
        // Reset All Day
        const adBtn=document.getElementById('mAllDayBtn');
        adBtn.classList.remove('active');
        adBtn.style.background='rgba(167,139,250,0.08)';
        adBtn.style.borderColor='rgba(167,139,250,0.2)';
        adBtn.style.color='rgba(167,139,250,0.7)';
        document.getElementById('mStart').readOnly=false;
        document.getElementById('mStart').style.opacity='1';
        document.getElementById('mEnd').readOnly=false;
        document.getElementById('mEnd').style.opacity='1';
        // Reset & show multi-day
        const mdBtn=document.getElementById('mMultiDayBtn');
        mdBtn.classList.remove('active');
        mdBtn.style.background='rgba(91,127,166,0.08)';
        mdBtn.style.color='rgba(91,127,166,0.7)';
        mdBtn.style.display='';
        document.getElementById('dpWrap2').style.display='none';
        document.getElementById('mDateTo').value='';
        document.getElementById('mDateToLabel').style.display='none';
        document.getElementById('modal').style.display='block';
    }

    function closeModal(){ document.getElementById('modal').style.display='none'; }

    function toggleMultiDay(){
        const btn=document.getElementById('mMultiDayBtn');
        const toWrap=document.getElementById('dpWrap2');
        const toLabel=document.getElementById('mDateToLabel');
        const isActive=btn.classList.toggle('active');
        if(isActive){
            btn.style.background='rgba(91,127,166,0.2)';
            btn.style.color='#5b8dd9';
            toWrap.style.display='';
            toLabel.style.display='';
            const v=document.getElementById('mDate').value;
            document.getElementById('mDateTo').value=v;
            dpSetText('dp2',v);
        } else {
            btn.style.background='rgba(91,127,166,0.08)';
            btn.style.color='rgba(91,127,166,0.7)';
            toWrap.style.display='none';
            toLabel.style.display='none';
            document.getElementById('mDateTo').value='';
        }
    }

    // Custom date picker
    const _dpState={dp1:{year:2026,month:3},dp2:{year:2026,month:3}};
    const _dpMonths=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const _dpDays=['Mo','Tu','We','Th','Fr','Sa','Su'];
    const _dpInput={dp1:'mDate',dp2:'mDateTo'};

    function dpSetText(id,val){
        if(!val){document.getElementById(id+'Text').textContent='--.--.----';return;}
        const p=val.split('-');
        document.getElementById(id+'Text').textContent=p[2]+'.'+p[1]+'.'+p[0];
    }

    function dpToggle(id){
        const popup=document.getElementById(id);
        const isOpen=popup.classList.contains('show');
        // Close all popups first
        document.querySelectorAll('.dp-popup.show').forEach(p=>p.classList.remove('show'));
        document.querySelectorAll('.date-pick-display.open').forEach(d=>d.classList.remove('open'));
        if(!isOpen){
            // Init month/year from current value
            const v=document.getElementById(_dpInput[id]).value;
            if(v){const p=v.split('-');_dpState[id].year=parseInt(p[0]);_dpState[id].month=parseInt(p[1])-1;}
            dpRender(id);
            popup.classList.add('show');
            popup.previousElementSibling.classList.add('open');
        }
    }

    function dpRender(id){
        const st=_dpState[id];
        const curVal=document.getElementById(_dpInput[id]).value;
        const today=new Date();
        const todayStr=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
        const first=new Date(st.year,st.month,1);
        let startDay=first.getDay()-1; if(startDay<0) startDay=6;
        const daysInMonth=new Date(st.year,st.month+1,0).getDate();
        const daysInPrev=new Date(st.year,st.month,0).getDate();

        let html='<div class="dp-nav">';
        html+='<button data-dp-nav="-1">&#9664;</button>';
        html+='<span>'+_dpMonths[st.month]+' '+st.year+'</span>';
        html+='<button data-dp-nav="1">&#9654;</button>';
        html+='</div><div class="dp-grid">';
        _dpDays.forEach(function(d){html+='<div class="dp-hdr">'+d+'</div>';});
        for(let i=startDay-1;i>=0;i--){
            html+='<div class="dp-day other">'+(daysInPrev-i)+'</div>';
        }
        for(let d=1;d<=daysInMonth;d++){
            const iso=st.year+'-'+String(st.month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
            const cls=[];
            if(iso===todayStr) cls.push('today');
            if(iso===curVal) cls.push('selected');
            html+='<div class="dp-day '+cls.join(' ')+'" data-dp-val="'+iso+'">'+d+'</div>';
        }
        const totalCells=startDay+daysInMonth;
        const rem=totalCells%7===0?0:7-totalCells%7;
        for(let i=1;i<=rem;i++){
            html+='<div class="dp-day other">'+i+'</div>';
        }
        html+='</div>';
        html+='<button class="dp-today-btn" data-dp-val="'+todayStr+'">Today</button>';
        document.getElementById(id).innerHTML=html;
    }

    // Event delegation for date pickers (avoids inline onclick escaping issues)
    ['dp1','dp2'].forEach(function(id){
        document.getElementById(id).addEventListener('click',function(e){
            e.stopPropagation();
            const nav=e.target.closest('[data-dp-nav]');
            if(nav){
                const dir=parseInt(nav.dataset.dpNav);
                _dpState[id].month+=dir;
                if(_dpState[id].month>11){_dpState[id].month=0;_dpState[id].year++;}
                if(_dpState[id].month<0){_dpState[id].month=11;_dpState[id].year--;}
                dpRender(id);
                return;
            }
            const sel=e.target.closest('[data-dp-val]');
            if(sel){
                const iso=sel.dataset.dpVal;
                document.getElementById(_dpInput[id]).value=iso;
                dpSetText(id,iso);
                document.getElementById(id).classList.remove('show');
                document.getElementById(id).previousElementSibling.classList.remove('open');
            }
        });
    });

    // Close date picker on outside click
    document.addEventListener('click',function(e){
        if(!e.target.closest('.date-pick-wrap')){
            document.querySelectorAll('.dp-popup.show').forEach(p=>p.classList.remove('show'));
            document.querySelectorAll('.date-pick-display.open').forEach(d=>d.classList.remove('open'));
        }
    });

    function toggleAllDay(){
        const btn = document.getElementById('mAllDayBtn');
        const startEl = document.getElementById('mStart');
        const endEl = document.getElementById('mEnd');
        const isActive = btn.classList.toggle('active');
        if(isActive){
            btn.style.background='rgba(167,139,250,0.2)';
            btn.style.borderColor='rgba(167,139,250,0.5)';
            btn.style.color='#a78bfa';
            startEl.value='00:00';
            endEl.value='23:59';
            startEl.readOnly=true;
            endEl.readOnly=true;
            startEl.style.opacity='0.5';
            endEl.style.opacity='0.5';
        } else {
            btn.style.background='rgba(167,139,250,0.08)';
            btn.style.borderColor='rgba(167,139,250,0.2)';
            btn.style.color='rgba(167,139,250,0.7)';
            startEl.value='';
            endEl.value='';
            startEl.readOnly=false;
            endEl.readOnly=false;
            startEl.style.opacity='1';
            endEl.style.opacity='1';
        }
    }

    function toggleSplitMode(){
        const sec = document.getElementById('mSplitSection');
        const btn = document.getElementById('mSplitBtn');
        const isOpen = sec.style.display === 'none';
        sec.style.display = isOpen ? 'block' : 'none';
        btn.style.background = isOpen ? 'rgba(91,127,166,0.2)' : 'rgba(66,165,245,0.06)';
        btn.style.borderColor = isOpen ? 'rgba(91,127,166,0.5)' : 'rgba(66,165,245,0.25)';
        btn.style.color = isOpen ? '#7ba3cc' : '#42a5f5';
        if(isOpen){ _splitReversed = false; _updateSplitPreview(); }
    }
    let _extraTraders = [];
    function addExtraTrader(){
        const mainName = document.getElementById('mName').value;
        const allOpts = Array.from(document.getElementById('mName').options).map(o=>o.value);
        // Pick first name not already used
        const used = [mainName, ..._extraTraders];
        const avail = allOpts.filter(n => !used.includes(n));
        if (avail.length === 0) { alert('All traders already added'); return; }
        _extraTraders.push(avail[0]);
        renderExtraTraders();
    }
    function removeExtraTrader(i){ _extraTraders.splice(i,1); renderExtraTraders(); }
    function changeExtraTrader(i, val){ _extraTraders[i] = val; renderExtraTraders(); }
    function renderExtraTraders(){
        const el = document.getElementById('mExtraTradersList');
        const mainName = document.getElementById('mName').value;
        const used = [mainName, ..._extraTraders];
        el.innerHTML = _extraTraders.map((name,i) => {
            const nc = pColors[name] || '#888';
            return '<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:'+nc+'11;border:1px solid '+nc+'33;border-radius:6px;">'
                +'<span style="width:8px;height:8px;border-radius:50%;background:'+nc+';flex-shrink:0;"></span>'
                +'<select onchange="changeExtraTrader('+i+',this.value)" style="flex:1;padding:3px 6px;background:#0a0b0f;border:1px solid #1e2030;color:#ccc;border-radius:4px;font-size:0.75rem;">'
                + Array.from(document.getElementById('mName').options).map(o =>
                    '<option value="'+o.value+'"'+(o.value===name?' selected':'')+'>'+o.value+'</option>'
                ).join('')
                +'</select>'
                +'<button onclick="removeExtraTrader('+i+')" style="background:rgba(244,67,54,0.1);color:#e57373;border:1px solid rgba(244,67,54,0.2);border-radius:4px;cursor:pointer;padding:2px 7px;font-size:0.8rem;">&#10005;</button>'
                +'</div>';
        }).join('');
    }
    function _timeToMins(t){ const [h,m]=(t||'00:00').split(':').map(Number); return h*60+m; }
    function _minsToTime(m){ m=((m%1440)+1440)%1440; return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); }
    let _splitReversed = false;
    function toggleSplitOrder(){ _splitReversed = !_splitReversed; _updateSplitPreview(); }
    function _updateSplitPreview(){
        const s=document.getElementById('mStart').value, e=document.getElementById('mEnd').value;
        const n1 = document.getElementById('mName').value;
        const n2 = document.getElementById('mSplitName').value;
        const firstName = _splitReversed ? n2 : n1;
        const secondName = _splitReversed ? n1 : n2;
        document.getElementById('splitName1').textContent = firstName;
        document.getElementById('splitName2').textContent = secondName;
        if(!s||!e){document.getElementById('splitHalf1').textContent='--';document.getElementById('splitHalf2').textContent='--';return;}
        const sm=_timeToMins(s), em=_timeToMins(e);
        const dur=(em>sm?em-sm:1440-sm+em);
        const mid=_minsToTime(sm+Math.floor(dur/2));
        document.getElementById('splitHalf1').textContent=s+' – '+mid;
        document.getElementById('splitHalf2').textContent=mid+' – '+e;
    }
    document.getElementById('mStart').addEventListener('input',()=>{if(document.getElementById('mSplitSection').style.display!=='none')_updateSplitPreview();});
    document.getElementById('mEnd').addEventListener('input',()=>{if(document.getElementById('mSplitSection').style.display!=='none')_updateSplitPreview();});

    async function saveShift(){
        const mode = document.getElementById('mMode').value;
        const baseData = {
            originalName:  document.getElementById('oName').value,
            originalDate:  document.getElementById('oDate').value,
            originalStart: document.getElementById('oStart').value,
            name:    document.getElementById('mName').value,
            date:    document.getElementById('mDate').value,
            start:   document.getElementById('mStart').value,
            end:     document.getElementById('mEnd').value,
            product: document.getElementById('mProd').value,
            trading: document.getElementById('mTrading').value,
            note:    document.getElementById('mNote').value,
            id:      _currentShiftSource ? (_currentShiftSource.id || '') : ''
        };
        // Build array of dates (multi-day support)
        const dateTo = document.getElementById('mDateTo').value;
        const multiDay = document.getElementById('mMultiDayBtn').classList.contains('active') && dateTo && mode === 'add';
        const dates = [];
        if (multiDay) {
            const d1 = new Date(baseData.date + 'T12:00:00');
            const d2 = new Date(dateTo + 'T12:00:00');
            if (d2 < d1) { alert('End date must be after start date'); return; }
            for (let dt = new Date(d1); dt <= d2; dt.setDate(dt.getDate() + 1)) {
                const y=dt.getFullYear(), m=String(dt.getMonth()+1).padStart(2,'0'), dd=String(dt.getDate()).padStart(2,'0');
                dates.push(y+'-'+m+'-'+dd);
            }
        } else {
            dates.push(baseData.date);
        }
        for (const saveDate of dates) {
        const data = {...baseData, date: saveDate};
        // DoubleShift / Split mode
        const splitOpen = document.getElementById('mSplitSection').style.display !== 'none';
        if (splitOpen) {
            const name2 = document.getElementById('mSplitName').value;
            if (!name2) { alert('Select second trader'); return; }
            const sm = _timeToMins(data.start), em = _timeToMins(data.end);
            const dur = em > sm ? em - sm : 1440 - sm + em;
            const mid = _minsToTime(sm + Math.floor(dur / 2));
            const firstN = _splitReversed ? name2 : data.name;
            const secondN = _splitReversed ? data.name : name2;
            const shift1 = {...data, name: firstN, end: mid, note: data.note ? data.note + ' [Split 1/2]' : 'Split 1/2'};
            const shift2 = {...data, name: secondN, start: mid, note: data.note ? data.note + ' [Split 2/2]' : 'Split 2/2'};
            const url = mode === 'add' ? '/add-shift' : '/update-shift';
            const [r1, r2] = await Promise.all([
                fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(shift1)}),
                fetch('/add-shift', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(shift2)})
            ]);
            if (!r1.ok || !r2.ok) { alert('Error saving split shift'); return; }
        } else if (_extraTraders.length > 0) {
            const url = mode === 'add' ? '/add-shift' : '/update-shift';
            const r1 = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
            if (!r1.ok) { alert('Error saving shift'); return; }
            for (const tName of _extraTraders) {
                if (mode === 'edit') {
                    // Try update existing crew shift
                    const crewData = {...data, name: tName, originalName: tName, originalDate: data.originalDate || data.date, originalStart: data.originalStart || data.start};
                    const r = await fetch('/update-shift', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(crewData)});
                    const rJson = r.ok ? await r.json() : null;
                    if (!rJson || !rJson.found) {
                        // Crew member not found in sheet — create new
                        const r2 = await fetch('/add-shift', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data, name: tName})});
                        if (!r2.ok) { alert('Error saving shift for ' + tName); return; }
                    }
                } else {
                    const r = await fetch('/add-shift', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data, name: tName})});
                    if (!r.ok) { alert('Error saving shift for ' + tName); return; }
                }
            }
        } else {
            // Editing a Schedule (non-manual) shift -> send override key so the server creates a ManualShift override hiding the Schedule slot
            if (mode==='edit' && _currentShiftSource && (_currentShiftSource.sheetTitle||'') && (_currentShiftSource.sheetTitle||'') !== 'ManualShifts') {
                data.overrideKey = (_currentShiftSource.name||'')+'|'+(_currentShiftSource.date||'')+'|'+(_currentShiftSource.product||'')+'|'+(_currentShiftSource.start||'')+'|'+(_currentShiftSource.end||'');
            }
            const resp = await fetch(mode==='add'?'/add-shift':'/update-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
            if (!resp.ok) { alert('Error saving shift'); return; }
        }
        } // end for-each saveDate
        // Navigate to the week containing the saved shift's date
        const savedDate = baseData.date;
        const currentParams = new URLSearchParams(window.location.search);
        const currentDate = currentParams.get('date');
        if (savedDate && savedDate !== currentDate) {
            const view = currentParams.get('view') || 'timeline';
            window.location.href = '/dashboard?date=' + savedDate + '&view=' + view;
        } else {
            location.reload();
        }
    }

    // =============================================
    // POINT 1b: PRODUCT DROPDOWN - dynamically by Trading
    // =============================================
    const productsByTrading = ${JSON.stringify(Object.fromEntries(tradingHierarchy.map(t => [t.name, t.subs])))};

    function updateProductDropdown() {
        const trading = document.getElementById('mTrading').value;
        const prodSel = document.getElementById('mProd');
        const products = productsByTrading[trading] || [];
        prodSel.innerHTML = '<option value="">-- Select Product --</option>'
            + products.map(p => '<option value="' + p + '">' + p + '</option>').join('');
    }

    // =============================================
    // POINT 2: EXCHANGE SHIFT
    // =============================================
    let _exchangeShift1 = null;
    let _exchangeShift2 = null;
    let _pickingMode = false;

    function startExchange() {
        if (!_currentShiftSource) return;
        _exchangeShift1 = {
            name:    document.getElementById('oName').value,
            date:    document.getElementById('oDate').value,
            start:   document.getElementById('mStart').value,
            end:     document.getElementById('mEnd').value,
            product: document.getElementById('mProd').value,
            sheetTitle: _currentShiftSource.sheetTitle,
            row:     _currentShiftSource.row,
            col:     _currentShiftSource.col
        };
        _exchangeShift2 = null;
        closeModal();

        // Show exchange modal + picking mode
        document.getElementById('exTitle1').textContent = _exchangeShift1.product;
        document.getElementById('exSub1').textContent   = _exchangeShift1.date;
        document.getElementById('exTime1').textContent  = _exchangeShift1.start + ' - ' + _exchangeShift1.end;
        document.getElementById('exName1').textContent  = _exchangeShift1.name;
        document.getElementById('exTitle2').textContent = 'Click a shift to select...';
        document.getElementById('exTitle2').style.color = '#555';
        document.getElementById('exSub2').textContent   = '';
        document.getElementById('exTime2').textContent  = '';
        document.getElementById('exName2').textContent  = '';
        document.getElementById('exCard2').classList.remove('selected');
        document.getElementById('exConfirmBtn').disabled = true;
        document.getElementById('exConfirmBtn').style.opacity = '0.4';
        // Show modal minimized at the bottom + picking mode
        const exModal = document.getElementById('exchangeModal');
        exModal.style.display = 'block';
        exModal.classList.add('picking-mode');

        // Aktivuj picking mode
        _pickingMode = true;
        document.body.classList.add('picking-exchange');
    }

    function pickShiftForExchange(name, date, start, end, product, note, trading, personColor, prodColor, sheetTitle, row, col) {
        if (!_pickingMode) return false;
        _exchangeShift2 = { name, date, start, end, product, sheetTitle, row: parseInt(row), col: parseInt(col) };
        document.getElementById('exTitle2').textContent = product;
        document.getElementById('exTitle2').style.color = '#fff';
        document.getElementById('exSub2').textContent   = date;
        document.getElementById('exTime2').textContent  = start + ' - ' + end;
        document.getElementById('exName2').textContent  = name;
        document.getElementById('exCard2').classList.add('selected');
        document.getElementById('exConfirmBtn').disabled = false;
        document.getElementById('exConfirmBtn').style.opacity = '1';
        document.body.classList.remove('picking-exchange');
        _pickingMode = false;
        // Obnov plny modal
        document.getElementById('exchangeModal').classList.remove('picking-mode');
        return true;
    }

    async function confirmExchange() {
        if (!_exchangeShift1 || !_exchangeShift2) return;
        const r = await fetch('/exchange-shift', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                sheet1: _exchangeShift1.sheetTitle, row1: _exchangeShift1.row, col1: _exchangeShift1.col, name1: _exchangeShift1.name, date1: _exchangeShift1.date, product1: _exchangeShift1.product,
                sheet2: _exchangeShift2.sheetTitle, row2: _exchangeShift2.row, col2: _exchangeShift2.col, name2: _exchangeShift2.name, date2: _exchangeShift2.date, product2: _exchangeShift2.product
            })
        });
        if (r.ok) { closeExchange(); location.reload(); }
        else { alert('Error: ' + await r.text()); }
    }

    function startPickingMode() {
        // Minimize modal and activate picking mode
        const exModal = document.getElementById('exchangeModal');
        exModal.classList.add('picking-mode');
        _pickingMode = true;
        document.body.classList.add('picking-exchange');
        document.getElementById('exTitle2').textContent = 'Click any shift on the dashboard...';
        document.getElementById('exSub2').textContent = 'Press ESC to cancel';
        document.getElementById('exSub2').style.color = '#42a5f5';
    }

    function closeExchange() {
        const exModal = document.getElementById('exchangeModal');
        exModal.style.display = 'none';
        exModal.classList.remove('picking-mode');
        document.body.classList.remove('picking-exchange');
        _pickingMode = false;
        _exchangeShift1 = null;
        _exchangeShift2 = null;
    }

    // ESC zavre picking mode
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (_pickingMode) { document.body.classList.remove('picking-exchange'); _pickingMode = false; }
            closeExchange();
            closeModal();
            closeConfirm();
        }
    });

    // =============================================
    // POINT 1: MOBILE MENU
    // =============================================
    function toggleMobileMenu() {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.getElementById('mobileOverlay');
        sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('show');
        document.body.style.overflow = sidebar.classList.contains('mobile-open') ? 'hidden' : '';
    }
    function closeMobileMenu() {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.getElementById('mobileOverlay');
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('show');
        document.body.style.overflow = '';
    }
    // Swipe to close sidebar
    (function() {
        let touchStartX = 0, touchStartY = 0, swiping = false;
        document.addEventListener('touchstart', function(e) {
            const sidebar = document.querySelector('.sidebar');
            if (!sidebar.classList.contains('mobile-open')) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            swiping = true;
        }, {passive: true});
        document.addEventListener('touchend', function(e) {
            if (!swiping) return;
            swiping = false;
            const dx = e.changedTouches[0].clientX - touchStartX;
            const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
            if (dx < -60 && dy < 100) closeMobileMenu();
        }, {passive: true});
    })();

    // =============================================
    // POINT 3+5: DELETE SHIFT and DELETE MONTH
    // =============================================
    let _currentShiftSource = null;

    function deleteShift() {
        if (!_currentShiftSource || !_currentShiftSource.sheetTitle) {
            alert('Cannot delete this shift - source not found. Try clicking the shift again.');
            return;
        }
        showConfirm(
            'Delete Shift',
            'Remove ' + _currentShiftSource.name + ' from ' + _currentShiftSource.product + ' on ' + _currentShiftSource.date + '?',
            async function() {
                const r = await fetch('/delete-shift', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({
                        sheetTitle: _currentShiftSource.sheetTitle,
                        row:        _currentShiftSource.row,
                        col:        _currentShiftSource.col,
                        name:       _currentShiftSource.name,
                        id:         _currentShiftSource.id || ''
                    })
                });
                if (r.ok) { closeModal(); location.reload(); }
                else { alert('Error: ' + await r.text()); }
            }
        );
    }

    function openDeleteMonth() {
        const p = new URLSearchParams(window.location.search);
        const dateStr = p.get('date') || new Date().toISOString().split('T')[0];
        const d = new Date(dateStr);
        const mN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const monthLabel = mN[d.getMonth()] + ' ' + d.getFullYear();
        const sheetTitle = 'Schedule - ' + monthLabel;
        showConfirm(
            'Delete All Shifts',
            'Are you sure you want to delete all shifts for ' + monthLabel + '? This cannot be undone.',
            async function() {
                const r = await fetch('/delete-month', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ sheetTitle })
                });
                if (r.ok) { location.reload(); }
                else { alert('Error: ' + await r.text()); }
            }
        );
    }

    function showConfirm(title, text, onYes) {
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmText').textContent = text;
        document.getElementById('confirmYesBtn').onclick = function() { closeConfirm(); onYes(); };
        document.getElementById('confirmDialog').style.display = 'block';
    }
    function closeConfirm() { document.getElementById('confirmDialog').style.display = 'none'; }

    // Slack subscriptions settings
    const _allTraderNames = ${JSON.stringify(allNames)};
    let _mySlackSubs = [];

    async function openSlackSettings() {
        document.getElementById('slackModal').style.display = 'block';
        const list = document.getElementById('slackSubsList');
        list.innerHTML = '<div style="text-align:center;padding:20px;color:#3a4050;font-size:0.75rem;">Loading...</div>';
        try {
            const r = await fetch('/api/slack-subscriptions');
            const data = await r.json();
            _mySlackSubs = data.subscriptions || [];
        } catch(e) { _mySlackSubs = []; }
        renderSlackSubs();
    }

    function renderSlackSubs() {
        const list = document.getElementById('slackSubsList');
        list.innerHTML = _allTraderNames.map(function(name) {
            const checked = _mySlackSubs.includes(name);
            return '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;cursor:pointer;border-bottom:1px solid #0e0f16;transition:background 0.1s;" onmouseover="this.style.background=\\'rgba(167,139,250,0.03)\\'" onmouseout="this.style.background=\\'transparent\\'">'
                + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleSlackSub(\\'' + name.replace(/'/g,'') + '\\',this.checked)" style="accent-color:#a78bfa;width:16px;height:16px;cursor:pointer;">'
                + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (pColors[name] || '#555') + ';flex-shrink:0;"></span>'
                + '<span style="font-size:0.78rem;color:' + (checked ? '#e8eaf0' : '#4a5060') + ';font-weight:' + (checked ? '600' : '400') + ';">' + name + '</span>'
                + '</label>';
        }).join('');
    }

    async function toggleSlackSub(name, add) {
        if (add) { _mySlackSubs.push(name); } else { _mySlackSubs = _mySlackSubs.filter(function(n){ return n !== name; }); }
        renderSlackSubs();
        await fetch('/api/slack-subscriptions', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ target: name, action: add ? 'add' : 'remove' })
        });
    }

    function closeSlackSettings() { document.getElementById('slackModal').style.display = 'none'; }

    // POINT 2: Loading spinner for sync
    function startSync() {
        const btn = document.getElementById('syncBtn');
        if (btn) {
            btn.innerHTML = '<span class="sync-spinner"></span> Syncing...';
            btn.disabled = true;
        }
        // Add ?sync=1 to force a reload from Google Sheets
        const p = new URLSearchParams(window.location.search);
        p.set('sync', '1');
        window.location.href = window.location.pathname + '?' + p.toString();
    }

    // Mini calendar
    // POINT 4: Calendar follows the currently displayed week
    const _viewDate = new URLSearchParams(window.location.search).get('date');
    const _baseDate = _viewDate ? new Date(_viewDate) : new Date();
    let calYear=_baseDate.getFullYear(), calMonth=_baseDate.getMonth();
    const mNames=['January','February','March','April','May','June','July','August','September','October','November','December'];

    function buildMiniCal(){
        const today=new Date();
        // Compute Monday and Sunday of the displayed week
        const vd=_viewDate ? new Date(_viewDate) : new Date();
        const dow=vd.getDay()||7; // Monday=1..Sunday=7
        const weekMon=new Date(vd); weekMon.setDate(vd.getDate()-(dow-1)); weekMon.setHours(0,0,0,0);
        const weekSun=new Date(weekMon); weekSun.setDate(weekMon.getDate()+6); weekSun.setHours(23,59,59,999);
        let h='<div class="mini-cal-nav"><button onclick="navCal(-1)">&#9664;</button><span>'+mNames[calMonth]+' '+calYear+'</span><button onclick="navCal(1)">&#9654;</button></div><div class="mini-cal-grid">';
        ['M','T','W','T','F','S','S'].forEach(d=>h+='<div style="color:#555;font-weight:bold;padding:2px;">'+d+'</div>');
        let first=new Date(calYear,calMonth,1).getDay()||7;
        for(let i=1;i<first;i++) h+='<div></div>';
        const dim=new Date(calYear,calMonth+1,0).getDate();
        for(let i=1;i<=dim;i++){
            const isT=(i===today.getDate()&&calMonth===today.getMonth()&&calYear===today.getFullYear());
            const ds=calYear+'-'+String(calMonth+1).padStart(2,'0')+'-'+String(i).padStart(2,'0');
            const cellDate=new Date(calYear,calMonth,i);
            const inWeek=cellDate>=weekMon&&cellDate<=weekSun;
            h+='<div class="m-date'+(isT?' today':'')+(inWeek?' cur-week':'')+'" onclick="saveSelection();location.href=\\'/dashboard?date='+ds+'\\'">' +i+'</div>';
        }
        document.getElementById('miniCal').innerHTML=h+'</div>';
    }
    function navCal(d){ calMonth+=d; if(calMonth>11){calMonth=0;calYear++;} if(calMonth<0){calMonth=11;calYear--;} buildMiniCal(); }
    buildMiniCal();

    // Timezone toggle
    let curTz=localStorage.getItem('ygg_tz')||'cet';
    const LIMA=-6;
    function toggleTimezone(){
        curTz=curTz==='cet'?'lima':'cet';
        localStorage.setItem('ygg_tz',curTz);
        const off=curTz==='lima'?LIMA:0;
        const btn=document.getElementById('tzToggle');
        // Remove any timezone continuation clones from previous toggle
        document.querySelectorAll('.tz-clone-pill').forEach(el=>el.remove());
        // Only reposition timeline pills (not week/list/agenda)
        const _tlVp=document.getElementById('viewport');
        if(!_tlVp){ /* not in timeline view — skip pill repositioning */ } else
        _tlVp.querySelectorAll('.shift-pill[data-orig-start]').forEach(pill=>{
            const od=parseInt(pill.dataset.origDay);
            const pp=parseInt(pill.dataset.pillPart||'0');
            const os=pill.dataset.origStart, oe=pill.dataset.origEnd;
            if(!os||!oe) return;
            const [sH,sM]=os.split(':').map(Number), [eH,eM]=oe.split(':').map(Number);
            let nsm=sH*60+sM+off*60, nem=eH*60+eM+off*60;
            // Normalize to 0-1440
            while(nsm<0) nsm+=1440; while(nsm>=1440) nsm-=1440;
            while(nem<0) nem+=1440; while(nem>=1440) nem-=1440;
            // Compute day offset based on pill part
            let dOff=0;
            const origSm=sH*60+sM, shiftedSm=origSm+off*60;
            if(shiftedSm<0) dOff=-1; else if(shiftedSm>=1440) dOff=1;
            // For pill part 2 (overnight continuation), shift day accordingly
            if(pp===2){
                const origEm=eH*60+eM, shiftedEm=origEm+off*60;
                if(shiftedEm<0) dOff=-1; else dOff=0;
                const nd=od+dOff;
                if(nd<0||nd>=7){pill.style.visibility='hidden';return;}
                // Check if shift is still overnight in new tz: start > end (and end not exactly midnight)
                const stillOvernight = nsm > nem && nem > 0;
                if(!stillOvernight){
                    // No longer crosses midnight — hide pill 2
                    pill.style.visibility='hidden'; return;
                }
                // Still overnight — show pill 2 from 00:00 to new end
                pill.style.visibility='visible';
                const ep2=(nem/1440)*100;
                const left2=(nd*100/7);
                const w2=ep2/7;
                pill.style.left=left2+'%'; pill.style.width=Math.max(w2,0.3)+'%';
                const te2=pill.querySelector('.pill-time');
                if(te2){
                    const neH=String(Math.floor(nem/60)).padStart(2,'0'), neMin=String(nem%60).padStart(2,'0');
                    te2.textContent='00:00 - '+neH+':'+neMin;
                }
                return;
            }
            const nd=od+dOff;
            if(nd<0||nd>=7){
                // If shift moved before week but is overnight and ends within the week, show the after-midnight part
                if(nd===-1 && nsm>nem && nem>0){
                    pill.style.visibility='visible';
                    const epClip=(nem/1440)*100;
                    pill.style.left='0%';
                    pill.style.width=Math.max(epClip/7,0.3)+'%';
                    const te=pill.querySelector('.pill-time');
                    if(te){
                        const neH=String(Math.floor(nem/60)).padStart(2,'0'),neMin=String(nem%60).padStart(2,'0');
                        te.textContent='00:00 - '+neH+':'+neMin;
                    }
                    return;
                }
                // If shift moved past week end but is overnight and starts within the week, show start→midnight
                if(nd===7 && nsm>nem && nem>0){
                    pill.style.visibility='visible';
                    const sp7=(nsm/1440)*100;
                    pill.style.left=(6*100/7)+(sp7/7)+'%';
                    pill.style.width=Math.max((100-sp7)/7,0.3)+'%';
                    const te=pill.querySelector('.pill-time');
                    if(te){
                        const nsH=String(Math.floor(nsm/60)).padStart(2,'0'),nsMin=String(nsm%60).padStart(2,'0');
                        te.textContent=nsH+':'+nsMin+' - 00:00';
                    }
                    return;
                }
                pill.style.visibility='hidden';return;
            }
            pill.style.visibility='visible';
            const sp=(nsm/1440)*100, ep=(nem/1440)*100;
            const left=(nd*100/7)+(sp/7);
            let w;
            if(pp===1){
                // Overnight pill 1: check if still overnight in new tz
                const stillON = nsm > nem && nem > 0;
                if(!stillON){
                    // No longer overnight — show full shift (start to end, or start to midnight if end=0)
                    const effEp = nem === 0 ? 100 : ep;
                    w=(effEp-sp)/7;
                } else {
                    // Still overnight — show start to midnight
                    w=(100-sp)/7;
                }
            } else {
                // pp===0: normal pill
                if(nsm > nem && nem > 0){
                    // Became overnight in new tz — show start to midnight only
                    w=(100-sp)/7;
                    // Create continuation clone on next day (00:00 → end)
                    if(nd < 6){
                        const clone=pill.cloneNode(true);
                        clone.classList.add('tz-clone-pill');
                        clone.removeAttribute('data-orig-start');
                        clone.style.left=((nd+1)*100/7)+'%';
                        clone.style.width=Math.max(ep/7,0.3)+'%';
                        clone.style.visibility='visible';
                        const cte=clone.querySelector('.pill-time');
                        if(cte){
                            const neH=String(Math.floor(nem/60)).padStart(2,'0'),neMin=String(nem%60).padStart(2,'0');
                            cte.textContent='00:00 - '+neH+':'+neMin;
                        }
                        pill.parentNode.appendChild(clone);
                    }
                } else {
                    const effEp = nem === 0 ? 100 : ep;
                    w=(effEp-sp)/7; if(w<=0) w=(100-sp)/7;
                }
            }
            pill.style.left=left+'%'; pill.style.width=Math.max(w,0.3)+'%';
            // Update pill time text: show start - end in new tz
            const te=pill.querySelector('.pill-time');
            if(te){
                const nsH=String(Math.floor(nsm/60)).padStart(2,'0'), nsMin=String(nsm%60).padStart(2,'0');
                const neH=String(Math.floor(nem/60)).padStart(2,'0'), neMin=String(nem%60).padStart(2,'0');
                te.textContent=nsH+':'+nsMin+' - '+neH+':'+neMin;
            }
        });

        // Week view: reposition pills vertically
        const _wkVp=document.getElementById('weekViewport');
        if(_wkVp){
            _wkVp.querySelectorAll('.shift-pill[data-orig-start]').forEach(pill=>{
                const os=pill.dataset.origStart, oe=pill.dataset.origEnd;
                if(!os||!oe) return;
                const [sH,sM]=os.split(':').map(Number),[eH,eM]=oe.split(':').map(Number);
                let nsm=sH*60+sM+off*60, nem=eH*60+eM+off*60;
                while(nsm<0) nsm+=1440; while(nsm>=1440) nsm-=1440;
                while(nem<0) nem+=1440; while(nem>=1440) nem-=1440;
                const isON=nsm>nem&&nem>0;
                const sTop=(nsm/1440)*(24*40);
                const height=isON?(1-nsm/1440)*(24*40):((nem===0?1440:nem)-nsm)/1440*(24*40);
                pill.style.top=sTop+'px';
                pill.style.height=Math.max(height,12)+'px';
            });
        }

        // Update time text in Week, List, Agenda views (.tz-time elements)
        document.querySelectorAll('.tz-time').forEach(el=>{
            const os=el.dataset.origStart, oe=el.dataset.origEnd;
            if(!os||!oe) return;
            const [sH,sM]=os.split(':').map(Number),[eH,eM]=oe.split(':').map(Number);
            let ns=sH*60+sM+off*60, ne=eH*60+eM+off*60;
            while(ns<0) ns+=1440; while(ns>=1440) ns-=1440;
            while(ne<0) ne+=1440; while(ne>=1440) ne-=1440;
            const nsH=String(Math.floor(ns/60)).padStart(2,'0'), nsMin=String(ns%60).padStart(2,'0');
            const neH=String(Math.floor(ne/60)).padStart(2,'0'), neMin=String(ne%60).padStart(2,'0');
            const prod=el.dataset.product;
            if(prod){
                // Week view: "HH:MM-HH:MM Product"
                el.textContent=nsH+':'+nsMin+'-'+neH+':'+neMin+' '+prod;
            } else {
                // List/Agenda view: "HH:MM – HH:MM"
                el.textContent=nsH+':'+nsMin+' \u2013 '+neH+':'+neMin;
            }
        });

        if(curTz==='lima'){
            if(btn){btn.classList.add('lima-active');}
            document.getElementById('tzLabel').textContent='LIMA';
            document.getElementById('tzBadge').textContent='-> EUROPE';
        } else {
            if(btn){btn.classList.remove('lima-active');}
            document.getElementById('tzLabel').textContent='EUROPE';
            document.getElementById('tzBadge').textContent='-> LIMA';
        }
        // Sync sidebar TZ toggle
        const sTz=document.querySelector('.sidebar-tz-label');
        const sTzBadge=document.querySelector('.sidebar-tz-toggle .tz-badge');
        if(sTz) sTz.textContent=curTz==='lima'?'LIMA':'EUROPE';
        if(sTzBadge) sTzBadge.textContent=curTz==='lima'?'-> EUROPE':'-> LIMA';
    }

    // POINT 2: Scroll always to the start = Monday
    window.onload=()=>{
        if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
        loadSharedColors(()=>{ applyCustomColorsToDOM(); });
        // Clean up warp arrival overlay + remove ?warp=1 from URL
        const wa = document.getElementById('warpArrival');
        if (wa) {
            wa.addEventListener('animationend', () => wa.remove());
            const url = new URL(window.location);
            url.searchParams.delete('warp');
            history.replaceState(null, '', url.pathname + url.search);
        }

        const vp=document.getElementById('viewport');
        if(vp) vp.scrollLeft=0;

        // Week view: scroll to current hour
        const wvp = document.getElementById('weekViewport');
        if (wvp) { const now = new Date(); wvp.scrollTop = Math.max(0, (now.getHours() - 2) * 40); }

        // Agenda view: scroll to today
        const agendaToday = document.getElementById('agendaToday');
        if (agendaToday) agendaToday.scrollIntoView({ block: 'start' });

        // List view: scroll to today + infinite scroll
        const listToday = document.getElementById('listToday');
        if (listToday) listToday.scrollIntoView({ block: 'start' });
        const _lv = document.getElementById('listViewport');
        if (_lv && window._listShifts) {
            const pColors = JSON.parse('${personColorsJSON}');
            let _ldRendered = window._listDaysRendered;
            let _ldStart = new Date(window._listStartISO);
            let _loading = false;
            function _isoLocal(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');return y+'-'+m+'-'+dd;}
            function _fmtD(dt){return dt.getDate().toString().padStart(2,'0')+'.'+(dt.getMonth()+1).toString().padStart(2,'0')+'.'+dt.getFullYear();}
            function _getWk(dt){const t=new Date(dt.getTime());t.setDate(t.getDate()+3-(t.getDay()+6)%7);const w=new Date(t.getFullYear(),0,4);return 1+Math.round(((t-w)/864e5-(w.getDay()+6)%7+3)/7);}
            const _dN=['sun','mon','tue','wed','thu','fri','sat'];
            function _calcDur(s,e){const[sh,sm]=s.split(':').map(Number),[eh,em]=e.split(':').map(Number);let d=(eh*60+em-sh*60-sm)/60;if(d<=0)d+=24;return d;}
            function _appendWeek(){
                if(_loading) return;
                _loading = true;
                const start = _ldRendered;
                for(let d=start;d<start+7;d++){
                    const dt=new Date(_ldStart);dt.setDate(_ldStart.getDate()+d);
                    const dStr=_isoLocal(dt), dow=dt.getDay(), isWE=dow===0||dow===6;
                    const shifts=window._listShifts.filter(s=>s.D===dStr).sort((a,b)=>a.S.localeCompare(b.S));
                    let h='';
                    if(dow===1||(d===start&&dow!==1)){
                        const ws=new Date(dt);if(dow!==1)ws.setDate(ws.getDate()-(dow===0?6:dow-1));
                        const we=new Date(ws);we.setDate(ws.getDate()+6);
                        h+='<div class="list-week-header" style="display:flex;justify-content:space-between;align-items:center;padding:10px 18px;background:#eef0f4;border-bottom:1px solid #ddd;position:sticky;top:0;z-index:5;">'
                          +'<span style="font-size:0.8rem;font-weight:600;color:#666;">'+_fmtD(ws)+' &ndash; '+_fmtD(we)+'</span>'
                          +'<span style="font-size:0.75rem;font-weight:700;color:#999;">Week '+_getWk(dt)+'</span></div>';
                    }
                    h+='<div style="display:flex;min-height:58px;border-bottom:1px solid #e8e8e8;'+(isWE?'background:#f0f6ff;':'background:#fff;')+'">';
                    h+='<div style="width:52px;flex-shrink:0;padding:12px 0;text-align:center;border-left:3px solid transparent;">'
                      +'<div style="font-size:1.5rem;font-weight:700;color:'+(isWE?'#5b8dd9':'#333')+';line-height:1;">'+dt.getDate()+'</div>'
                      +'<div style="font-size:0.6rem;font-weight:600;color:'+(isWE?'#7aabec':'#999')+';margin-top:2px;">'+_dN[dow]+'</div></div>';
                    h+='<div style="flex:1;padding:8px 12px 8px 8px;">';
                    if(shifts.length===0){h+='<div style="padding:8px 0;font-size:0.78rem;color:#bbb;font-style:italic;">No events</div>';}
                    else{shifts.forEach(s=>{
                        const pc=pColors[s.N]||'#555',prc=s.P in (window.pColorsProduct||{})?window.pColorsProduct[s.P]:'#888';
                        h+='<div class="user-row product-row" data-name="'+s.N+'" data-product-row="'+s.P+'" style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f0f0f0;border-radius:10px;margin-bottom:5px;cursor:pointer;border-left:4px solid '+prc+';box-shadow:0 1px 3px rgba(0,0,0,0.06);"'
                          +' onclick="openViewModal(\\''+s.N.replace(/'/g,'')+'\\',\\''+dStr+'\\',\\''+s.S+'\\',\\''+s.E+'\\',\\''+s.P.replace(/'/g,'')+'\\',\\''+s.No.replace(/'/g,'')+'\\',\\''+s.T+'\\',\\''+pc+'\\',\\''+prc+'\\',\\''+s._s+'\\','+s._r+','+s._c+')">'
                          +'<div style="flex:1;min-width:0;">'
                          +'<div style="font-weight:700;font-size:0.85rem;color:#222;display:flex;align-items:center;gap:6px;">'
                          +'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+prc+';flex-shrink:0;"></span>'+s.P+'</div>'
                          +'<div style="font-size:0.72rem;color:#888;margin-top:3px;">'
                          +'<span class="tz-time" data-orig-start="'+s.S+'" data-orig-end="'+s.E+'">'+s.S+' - '+s.E+'</span>, '+s.T+' &gt; '+s.N+'</div></div>'
                          +'<div style="text-align:right;flex-shrink:0;color:#aaa;font-size:0.68rem;">'+_calcDur(s.S,s.E).toFixed(1)+'h</div></div>';
                    });}
                    h+='</div></div>';
                    _lv.insertAdjacentHTML('beforeend',h);
                }
                _ldRendered+=7;
                _loading=false;
                if(typeof applyAllFilters==='function') applyAllFilters();
            }
            if(window.innerWidth<=768){
                _lv.addEventListener('scroll',function(){
                    if(_lv.scrollTop+_lv.clientHeight>=_lv.scrollHeight-200) _appendWeek();
                });
            }
        }

        // Obnov vybrane osoby / produkty z localStorage
        const savedNames = (localStorage.getItem('ygg_sel_names') || '').split('||').filter(Boolean);
        const savedProds = (localStorage.getItem('ygg_sel_prods') || '').split('||').filter(Boolean);
        if (savedNames.length || savedProds.length) {
            savedNames.forEach(n => {
                const el = document.querySelector('.user-item[data-name="' + n + '"]');
                if (el) { el.classList.add('active'); }
            });
            savedProds.forEach(p => {
                const el = document.querySelector('.product-selector[data-product-name="' + p + '"]');
                if (el) { el.classList.add('active'); }
            });
            applyAllFilters();
        }
        // Remove pre-filter style after filters are applied
        const pfs = document.getElementById('pre-filter-style');
        if (pfs) pfs.remove();

        // Restore Lima timezone if it was active
        if (localStorage.getItem('ygg_tz') === 'lima') {
            curTz = 'cet'; // toggleTimezone will flip it to 'lima'
            toggleTimezone();
        }

        // Detect overlapping shifts - mark with red blinking
        const rows = document.querySelectorAll('.timeline-row');
        rows.forEach(row => {
            const pills = Array.from(row.querySelectorAll('.shift-pill'));
            pills.forEach((pill, i) => {
                const left1 = parseFloat(pill.style.left);
                const w1    = parseFloat(pill.style.width);
                pills.forEach((other, j) => {
                    if (i >= j) return;
                    // Blikat jen kdyz se jedna o stejneho cloveka
                    if (!pill.dataset.person || pill.dataset.person !== other.dataset.person) return;
                    // Skip the two halves of the same night shift
                    if (pill.dataset.origStart === other.dataset.origStart &&
                        pill.dataset.origEnd   === other.dataset.origEnd) return;
                    const left2 = parseFloat(other.style.left);
                    const w2    = parseFloat(other.style.width);
                    // Epsilon 0.01% due to floating point (07:12|07:12 adjacent shifts must not flicker)
                    if (left1 + 0.01 < left2 + w2 && left1 + w1 > left2 + 0.01) {
                        pill.classList.add('overlap');
                        other.classList.add('overlap');
                    }
                });
            });
        });
    };

    // Sync modal
    function openSyncModal() {
        const sel = document.getElementById('syncSheetSelect');
        sel.innerHTML = '<option value="">Loading...</option>';
        document.getElementById('syncModal').style.display = 'block';
        fetch('/api/schedule-sheets')
            .then(r => r.json())
            .then(sheets => {
                if (!sheets.length) { sel.innerHTML = '<option value="">No sheets found</option>'; return; }
                sel.innerHTML = sheets.map(s => '<option value="' + s + '">' + s + '</option>').join('');
            })
            .catch(() => { sel.innerHTML = '<option value="">Error loading sheets</option>'; });
    }
    function closeSyncModal() { document.getElementById('syncModal').style.display = 'none'; }
    function confirmSync() {
        const sheet = document.getElementById('syncSheetSelect').value;
        closeSyncModal();
        const btn = document.getElementById('syncBtn');
        if (btn) { btn.innerHTML = '<span class="sync-spinner"></span> Syncing...'; btn.disabled = true; }
        const p = new URLSearchParams(window.location.search);
        p.set('sync', '1');
        if (sheet) p.set('syncSheet', encodeURIComponent(sheet));
        window.location.href = window.location.pathname + '?' + p.toString();
    }

    // =============================================
    // AI SCHEDULE GENERATOR
    // =============================================
    function openAIGenModal() {
        document.getElementById('aiGenModal').style.display = 'block';
        aiGenReset();
        const monthSel = document.getElementById('aiGenMonth');
        monthSel.innerHTML = '<option value="">Loading...</option>';
        fetch('/api/schedule-sheets').then(r => r.json()).then(sheets => {
            if (!sheets || !sheets.length) { monthSel.innerHTML = '<option value="">No sheets found</option>'; return; }
            const months = sheets.map(s => s.replace(/^Schedule - /, ''));
            monthSel.innerHTML = months.map(m => '<option value="' + m + '">' + m + '</option>').join('');
        }).catch(() => { monthSel.innerHTML = '<option value="">Error loading sheets</option>'; });
        const prodSel = document.getElementById('aiGenProduct');
        const products = window._productList || [];
        prodSel.innerHTML = products.map(p => '<option value="' + p + '">' + p + '</option>').join('');
    }

    function closeAIGenModal() {
        document.getElementById('aiGenModal').style.display = 'none';
    }

    function aiGenReset() {
        document.getElementById('aiGenStep1').style.display = 'block';
        document.getElementById('aiGenStep2').style.display = 'none';
        document.getElementById('aiGenStep3').style.display = 'none';
        document.getElementById('aiGenCommitResult').innerHTML = '';
        window._aiGenLastResult = null;
    }

    async function aiGenRun() {
        const month = document.getElementById('aiGenMonth').value;
        const product = document.getElementById('aiGenProduct').value;
        const apc = document.getElementById('aiGenApc').checked;
        if (!month || !product) { alert('Select month + product'); return; }
        document.getElementById('aiGenStep1').style.display = 'none';
        document.getElementById('aiGenStep2').style.display = 'block';
        const prog = document.getElementById('aiGenProgress');
        const t0 = Date.now();
        const tick = setInterval(() => {
            prog.textContent = 'Calling Claude API for ' + product + ' / ' + month + '... (' + Math.round((Date.now() - t0) / 1000) + 's)';
        }, 1000);
        try {
            const resp = await fetch('/api/generate-schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ month, product, allowPartialCoverage: apc })
            });
            const data = await resp.json();
            clearInterval(tick);
            if (!resp.ok) {
                document.getElementById('aiGenStep2').style.display = 'none';
                document.getElementById('aiGenStep1').style.display = 'block';
                alert('API error: ' + (data.error || resp.status));
                return;
            }
            window._aiGenLastResult = data;
            renderAIGenResult(data);
        } catch (err) {
            clearInterval(tick);
            document.getElementById('aiGenStep2').style.display = 'none';
            document.getElementById('aiGenStep1').style.display = 'block';
            alert('Network error: ' + err.message);
        }
    }

    function renderAIGenResult(data) {
        document.getElementById('aiGenStep2').style.display = 'none';
        document.getElementById('aiGenStep3').style.display = 'block';
        const errs = (data.validation && data.validation.errors) || [];
        const warns = (data.validation && data.validation.warnings) || [];
        const cost = data.usage ? ((data.usage.input_tokens * 15 + (data.usage.output_tokens || 0) * 75) / 1000000).toFixed(3) : '?';
        const repairBadge = data.repairAttempted ? '<span style="background:rgba(255,152,0,0.15);color:#ffb74d;border:1px solid rgba(255,152,0,0.3);padding:1px 8px;border-radius:10px;font-size:0.65rem;font-weight:700;margin-left:8px;">REPAIRED (init ' + data.initialErrorCount + ' errs)</span>' : '';
        document.getElementById('aiGenSummary').innerHTML =
            '<div style="background:#0e1621;border:1px solid #1e2d3d;border-radius:8px;padding:12px 14px;">'
            + '<div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center;"><span style="color:#7ba3cc;font-weight:700;">' + data.product + ' / ' + data.monthLabel + repairBadge + '</span><span style="color:#888;font-size:0.8rem;">' + (data.elapsedMs/1000).toFixed(1) + 's</span></div>'
            + '<div style="color:#aaa;font-size:0.82rem;line-height:1.7;">'
            + 'Shifts: <b style="color:#eee;">' + data.shiftCount + '</b>  |  '
            + 'Tokens: ' + (data.usage && data.usage.input_tokens || '?') + ' in / ' + (data.usage && data.usage.output_tokens || '?') + ' out  |  '
            + 'Cost: ~$' + cost + '</div></div>';
        document.getElementById('aiGenValidation').innerHTML =
            '<div style="padding:10px 14px;border-radius:6px;' + (errs.length === 0 ? 'background:rgba(76,175,80,0.1);border-left:3px solid #4caf50;color:#a5d6a7;' : 'background:rgba(244,67,54,0.1);border-left:3px solid #f44336;color:#ef9a9a;') + '">'
            + (errs.length === 0 ? '&#9989; Validation: OK — ' + warns.length + ' warnings'
                : '&#10060; Validation: ' + errs.length + ' hard errors, ' + warns.length + ' warnings<div style="margin-top:6px;font-size:0.78rem;font-family:monospace;color:#fff;">'
                  + errs.slice(0, 5).map(e => '• ' + e.msg).join('<br>') + (errs.length > 5 ? '<br>... +' + (errs.length - 5) + ' more' : '') + '</div>')
            + '</div>';
        if (data.generatorNotes) {
            document.getElementById('aiGenNotes').innerHTML =
                '<div style="background:rgba(91,127,166,0.06);border-left:3px solid #7ba3cc;padding:10px 14px;border-radius:4px;font-size:0.82rem;color:#aaa;line-height:1.5;"><b style="color:#7ba3cc;">Claude notes:</b> ' + data.generatorNotes + '</div>';
        }
        const shifts = data.shifts || [];
        const sorted = shifts.slice().sort((a, b) => (a.date || '').localeCompare(b.date) || a.slotIndex - b.slotIndex);
        const kinds = ['night', 'morning', 'afternoon'];
        document.getElementById('aiGenShiftsPreview').innerHTML =
            sorted.slice(0, 30).map(s => s.date + ' ' + kinds[s.slotIndex].padEnd(10) + ' ' + s.person).join('<br>')
            + (sorted.length > 30 ? '<br>... +' + (sorted.length - 30) + ' more' : '');
    }

    async function aiGenCommit(overwrite) {
        const data = window._aiGenLastResult;
        if (!data) { alert('No result to commit'); return; }
        const errs = (data.validation && data.validation.errors) || [];
        if (errs.length > 0) {
            if (!confirm('Validator detected ' + errs.length + ' hard errors. Commit anyway?')) return;
        }
        const commitBtn = document.getElementById('aiGenCommitBtn');
        const ovBtn = document.getElementById('aiGenOverwriteBtn');
        commitBtn.disabled = true; ovBtn.disabled = true;
        commitBtn.textContent = 'Writing...'; ovBtn.style.opacity = '0.5';
        try {
            const resp = await fetch('/api/commit-to-schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ month: data.monthLabel, product: data.product, shifts: data.shifts, overwrite: overwrite })
            });
            const result = await resp.json();
            const resultBox = document.getElementById('aiGenCommitResult');
            if (!resp.ok) {
                resultBox.innerHTML = '<div style="background:rgba(244,67,54,0.1);border-left:3px solid #f44336;padding:10px 14px;border-radius:6px;color:#ef9a9a;">&#10060; Error: ' + (result.error || resp.status) + '</div>';
            } else if (result.ok === false) {
                resultBox.innerHTML = '<div style="background:rgba(255,152,0,0.1);border-left:3px solid #ff9800;padding:10px 14px;border-radius:6px;color:#ffcc80;">&#9888; ' + result.conflicts + ' conflicts blocked write. Click COMMIT + OVERWRITE to force.<div style="margin-top:6px;font-size:0.75rem;font-family:monospace;color:#fff;">' + (result.conflictDetails || []).slice(0, 5).map(c => '• ' + c.sheetDate + ' slot ' + c.slotIndex + ' (' + c.person + ') vs current "' + c.currentValue + '"').join('<br>') + '</div></div>';
            } else {
                resultBox.innerHTML = '<div style="background:rgba(76,175,80,0.1);border-left:3px solid #4caf50;padding:10px 14px;border-radius:6px;color:#a5d6a7;">&#9989; Committed ' + result.written + ' cells to "' + result.sheetTitle + '". Skipped: ' + result.skipped + '.<div style="margin-top:6px;font-size:0.78rem;color:#888;">WRITE: ' + result.actions.WRITE + ', OVERWRITE: ' + result.actions.OVERWRITE + ', SAME: ' + result.actions.SAME + '</div></div><div style="margin-top:8px;font-size:0.8rem;color:#7ba3cc;">Dashboard refresh in 2s...</div>';
                setTimeout(() => {
                    const p = new URLSearchParams(window.location.search);
                    p.set('sync', '1');
                    window.location.href = window.location.pathname + '?' + p.toString();
                }, 2000);
            }
        } catch (err) {
            document.getElementById('aiGenCommitResult').innerHTML = '<div style="background:rgba(244,67,54,0.1);color:#ef9a9a;padding:10px 14px;border-radius:6px;">Network error: ' + err.message + '</div>';
        } finally {
            commitBtn.disabled = false; ovBtn.disabled = false;
            commitBtn.innerHTML = '&#9989; COMMIT TO SHEET'; ovBtn.style.opacity = '1';
        }
    }

    // BATCH GENERATOR: projde vsechny produkty postupne s auto-commit
    async function aiGenBatch() {
        const month = document.getElementById('aiGenMonth').value;
        const apc = document.getElementById('aiGenApc').checked;
        if (!month) { alert('Select month'); return; }
        const products = window._productList || [];
        if (!products.length) { alert('No products'); return; }

        if (!confirm('Generate schedule for ALL ' + products.length + ' products? Cost approx $5-8, time ~' + Math.round(products.length * 1.2) + ' min. Auto-commit to sheet after each product (with overwrite).')) return;

        document.getElementById('aiGenStep1').style.display = 'none';
        document.getElementById('aiGenStep2').style.display = 'block';
        document.getElementById('aiGenProgress').innerHTML = '<div id="aiGenBatchLog" style="text-align:left;max-height:400px;overflow-y:auto;background:#0e1621;padding:10px;border-radius:6px;font-family:monospace;font-size:0.78rem;color:#aaa;"></div>';

        function log(msg, color) {
            const logEl = document.getElementById('aiGenBatchLog');
            logEl.innerHTML += '<div style="color:' + (color || '#aaa') + ';">' + msg + '</div>';
            logEl.scrollTop = logEl.scrollHeight;
        }

        const t0 = Date.now();
        let totalCost = 0, totalShifts = 0, totalErrors = 0, totalCommitted = 0;
        const accumulated = [];

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            log('[' + (i+1) + '/' + products.length + '] Generating ' + product + '...', '#7ba3cc');
            try {
                const genResp = await fetch('/api/generate-schedule', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ month, product, allowPartialCoverage: apc, accumulatedShifts: accumulated })
                });
                const genData = await genResp.json();
                if (!genResp.ok) { log('  ERR API: ' + (genData.error || genResp.status), '#ef9a9a'); continue; }
                const errs = (genData.validation && genData.validation.errors || []).length;
                const warns = (genData.validation && genData.validation.warnings || []).length;
                const cost = genData.usage ? ((genData.usage.input_tokens * 15 + (genData.usage.output_tokens || 0) * 75) / 1000000) : 0;
                totalCost += cost; totalShifts += genData.shiftCount || 0; totalErrors += errs;
                log('  OK ' + (genData.shiftCount || 0) + ' shifts, ' + errs + ' errors, ' + warns + ' warns, $' + cost.toFixed(2) + (genData.repairAttempted ? ' (repaired)' : ''), errs === 0 ? '#a5d6a7' : '#ffcc80');
                if (genData.enrichedShifts) accumulated.push.apply(accumulated, genData.enrichedShifts);

                log('  Committing...', '#888');
                const commitResp = await fetch('/api/commit-to-schedule', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ month, product, shifts: genData.shifts, overwrite: true })
                });
                const commitData = await commitResp.json();
                if (!commitResp.ok || commitData.ok === false) {
                    log('  Commit warn: ' + (commitData.error || JSON.stringify(commitData.actions || {})), '#ffb74d');
                } else {
                    log('  Committed ' + commitData.written + ' cells (skip ' + commitData.skipped + ')', '#a5d6a7');
                    totalCommitted += commitData.written;
                }
            } catch (err) {
                log('  ERR ' + err.message, '#ef9a9a');
            }
        }

        const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
        log('', '#aaa');
        log('=== BATCH DONE ===', '#7ba3cc');
        log('Total: ' + products.length + ' products, ' + totalCommitted + ' cells committed', '#a5d6a7');
        log('Errors across: ' + totalErrors + ' (manually in Sheet)', totalErrors === 0 ? '#a5d6a7' : '#ffcc80');
        log('Cost: $' + totalCost.toFixed(2) + ', time: ' + elapsedMin + ' min', '#aaa');
        log('Dashboard refresh in 5s...', '#7ba3cc');
        setTimeout(() => {
            const p = new URLSearchParams(window.location.search);
            p.set('sync', '1');
            window.location.href = window.location.pathname + '?' + p.toString();
        }, 5000);
    }

    // CSV Export modal
    function openExportModal() {
        document.getElementById('exportModal').style.display = 'block';
    }
    function closeExportModal() {
        document.getElementById('exportModal').style.display = 'none';
    }
    function updateExportCount(){
        const checked = document.querySelectorAll('.export-cb:checked');
        document.getElementById('exportCountLabel').textContent = checked.length + ' selected' + (checked.length === 0 ? ' — downloads all' : '');
    }
    function confirmExportCSV() {
        const checked = Array.from(document.querySelectorAll('.export-cb:checked')).map(c=>c.value);
        closeExportModal();
        if (checked.length === 0) { window.location.href = '/export-csv'; return; }
        checked.forEach((name, i) => {
            setTimeout(() => { window.location.href = '/export-csv?name=' + encodeURIComponent(name); }, i * 300);
        });
    }

    // =============================================
    // REFRESH BUTTON
    // =============================================
    function refreshDashboard(){
        const btn=document.getElementById('refreshBtn');
        if(btn) btn.style.transform='rotate(360deg)';
        const p=new URLSearchParams(window.location.search);
        p.set('sync','1');
        setTimeout(()=>{ window.location.href='/dashboard?'+p.toString(); },300);
    }

    // =============================================
    // SHIFT HOVER TOOLTIP
    // =============================================
    const _tt = document.getElementById('shiftTooltip');
    let _ttTimer = null;
    function _showTooltip(e, name, start, end, product, trading, note, personColor, prodColor, shiftDate) {
        clearTimeout(_ttTimer);
        const pc = pColors[name] || personColor || '#888';
        document.getElementById('ttHeader').innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;">'
            + '<span style="width:10px;height:10px;border-radius:50%;background:'+pc+';flex-shrink:0;box-shadow:0 0 6px '+pc+'66;"></span>'
            + '<span style="font-weight:700;font-size:0.88rem;color:#e8eaf0;">'+name+'</span>'
            + '</div>';
        // Show converted time when in Lima mode
        let dispStart = start, dispEnd = end;
        if (curTz === 'lima') {
            function _convTime(t, off) {
                const [h,m] = (t||'00:00').split(':').map(Number);
                let mins = h*60+m+off*60;
                while(mins<0) mins+=1440; while(mins>=1440) mins-=1440;
                return String(Math.floor(mins/60)).padStart(2,'0')+':'+String(mins%60).padStart(2,'0');
            }
            dispStart = _convTime(start, LIMA);
            dispEnd = _convTime(end, LIMA);
        }
        document.getElementById('ttTime').textContent = dispStart + ' \u2013 ' + dispEnd;
        document.getElementById('ttProduct').innerHTML =
            '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+prodColor+';margin-right:5px;vertical-align:middle;"></span>'
            + trading + ' \\u203a ' + product;
        const noteEl = document.getElementById('ttNote');
        noteEl.textContent = note || '';
        noteEl.style.display = note ? 'block' : 'none';
        // Crew display in tooltip
        const crewEl = document.getElementById('ttCrew');
        if (crewEl && shiftDate) {
            const crewKey = shiftDate+'|'+product+'|'+start+'|'+end;
            const crewAll = _crewMap[crewKey] || [];
            const crewOthers = crewAll.filter(n => n !== name);
            if (crewOthers.length > 0) {
                let h = '<div style="font-size:0.65rem;color:#8892a4;margin-bottom:3px;">Crew:</div><div style="display:flex;flex-wrap:wrap;gap:3px;">';
                crewOthers.forEach(c => {
                    const cc = pColors[c] || '#888';
                    h += '<span style="font-size:0.6rem;padding:1px 6px;border-radius:3px;background:'+cc+'33;color:'+cc+';border:1px solid '+cc+'55;">'+c+'</span>';
                });
                h += '</div>';
                crewEl.innerHTML = h;
                crewEl.style.display = 'block';
            } else {
                crewEl.style.display = 'none';
            }
        } else if (crewEl) {
            crewEl.style.display = 'none';
        }
        _positionTooltip(e);
        _tt.style.display = 'block';
    }
    function _positionTooltip(e) {
        const margin = 14;
        const tw = 260, th = 130;
        let x = e.clientX + margin;
        let y = e.clientY + margin;
        if (x + tw > window.innerWidth - 10) x = e.clientX - tw - margin;
        if (y + th > window.innerHeight - 10) y = e.clientY - th - margin;
        _tt.style.left = x + 'px';
        _tt.style.top  = y + 'px';
    }
    function _hideTooltip() {
        _ttTimer = setTimeout(() => { _tt.style.display = 'none'; }, 80);
    }
    document.addEventListener('mouseover', e => {
        const pill = e.target.closest('.shift-pill');
        if (!pill) return;
        const name    = pill.dataset.person || pill.dataset.name || '';
        const start   = pill.dataset.origStart || '';
        const end     = pill.dataset.origEnd || '';
        const product = pill.dataset.tooltipProduct || '';
        const trading = pill.dataset.tooltipTrading || '';
        const note    = pill.dataset.tooltipNote || '';
        const pc      = pill.dataset.personColor || '';
        const prodC   = pill.dataset.prodColor || '';
        const sDate   = pill.dataset.shiftDate || '';
        if (!name) return;
        _showTooltip(e, name, start, end, product, trading, note, pc, prodC, sDate);
    });
    document.addEventListener('mousemove', e => {
        if (_tt.style.display === 'none') return;
        if (e.target.closest('.shift-pill')) _positionTooltip(e);
    });
    document.addEventListener('mouseout', e => {
        if (e.target.closest('.shift-pill')) _hideTooltip();
    });

    // =============================================
    // COLOR PICKER
    // =============================================
    let _sharedColors = {};
    function applyCustomColorsToDOM(){
        try {
            const cc = _sharedColors;
            if(!Object.keys(cc).length) return;
            Object.keys(cc).forEach(name => {
                const newColor = cc[name];
                if(!newColor) return;
                pColors[name] = newColor;
                const sideEl = document.querySelector('.user-item[data-name="'+name+'"]');
                if(sideEl){
                    sideEl.style.borderLeftColor = newColor;
                    const dot = sideEl.querySelector('span');
                    if(dot) dot.style.background = newColor;
                }
                document.querySelectorAll('.timeline-row[data-name="'+name+'"] span[style*="color"]').forEach(sp => {
                    sp.style.color = newColor;
                });
                document.querySelectorAll('[data-person="'+name+'"], .shift-pill[data-name="'+name+'"]').forEach(el => {
                    if(!el.classList.contains('shift-pill')) return;
                    const prodColor = el.dataset.prodColor;
                    if(!prodColor) return;
                    el.dataset.personColor = newColor;
                    const bg = 'repeating-linear-gradient(135deg,'+newColor+' 0px,'+newColor+' 40px,'+prodColor+' 40px,'+prodColor+' 80px)';
                    el.style.background = bg;
                    el.style.borderRight = '3px solid '+prodColor;
                });
            });
        } catch(e){}
    }
    function loadSharedColors(cb){
        fetch('/api/custom-colors').then(r=>r.json()).then(cc=>{
            _sharedColors=cc; if(cb)cb();
        }).catch(()=>{ if(cb)cb(); });
    }

    const _defaultColors = ${personColorsJSON};
    function openColorPicker(){
        document.getElementById('colorPickerModal').style.display='block';
        renderColorList();
    }
    function closeColorPicker(){
        document.getElementById('colorPickerModal').style.display='none';
        applyCustomColorsToDOM();
    }
    function renderColorList(){
        const q=(document.getElementById('colorSearch')||{}).value||'';
        const cc=_sharedColors;
        const names=Object.keys(pColors).filter(n=>!q||n.toLowerCase().includes(q.toLowerCase()));
        document.getElementById('colorList').innerHTML=names.map(n=>{
            const cur=cc[n]||pColors[n]||'#888';
            return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #1a1d2a;">'
                +'<span style="width:10px;height:10px;border-radius:50%;background:'+cur+';flex-shrink:0;box-shadow:0 0 5px '+cur+'66;"></span>'
                +'<span style="flex:1;font-size:0.82rem;color:#c8d0e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+n+'</span>'
                +'<input type="color" value="'+cur+'" onchange="setPersonColor(\\\''+n.replace(/'/g,'')+'\\\',this.value)" style="width:32px;height:24px;border:none;background:none;cursor:pointer;padding:0;">'
                +'</div>';
        }).join('');
    }
    function setPersonColor(name,color){
        _sharedColors[name]=color;
        pColors[name]=color;
        renderColorList();
        applyCustomColorsToDOM();
        fetch('/api/set-color',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,color:color}),credentials:'same-origin'});
    }
    function resetAllColors(){
        if(!confirm('Reset all colors to default?')) return;
        _sharedColors={};
        Object.keys(_defaultColors).forEach(k => pColors[k] = _defaultColors[k]);
        applyCustomColorsToDOM();
        renderColorList();
        fetch('/api/reset-colors',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});
    }
</script>
<div id="peopleAdminModal" style="display:none;position:fixed;z-index:3000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);">
  <div style="max-width:760px;margin:40px auto;background:#13141c;border:1px solid #2a2d3a;border-radius:14px;max-height:88vh;overflow:auto;padding:22px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 style="color:#b39ddb;font-size:1.1rem;margin:0;">&#128101; Manage People</h2>
      <button onclick="closePeopleAdmin()" style="background:none;border:none;color:#888;font-size:1.4rem;cursor:pointer;">&times;</button>
    </div>
    <div id="paFormWrap" style="background:rgba(255,255,255,0.03);border:1px solid #2a2d3a;border-radius:10px;padding:14px;margin-bottom:16px;">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <label style="font-size:0.7rem;color:#9aa;">Name<br><input id="paName" style="padding:7px;background:#0d0e14;color:#eee;border:1px solid #2a2d3a;border-radius:6px;width:170px;"></label>
        <label style="font-size:0.7rem;color:#9aa;">Group<br><select id="paGroup" style="padding:7px;background:#0d0e14;color:#eee;border:1px solid #2a2d3a;border-radius:6px;"></select></label>
        <label style="font-size:0.7rem;color:#9aa;">Color<br><input id="paColor" type="color" value="#8888aa" style="padding:2px;background:#0d0e14;border:1px solid #2a2d3a;border-radius:6px;height:34px;width:48px;"></label>
      </div>
      <div style="font-size:0.7rem;color:#9aa;margin:12px 0 6px;">Eligibility (products):</div>
      <div id="paProducts" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
      <div style="margin-top:14px;display:flex;gap:8px;">
        <button id="paSaveBtn" onclick="paSave()" style="background:#7e57c2;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;">Add</button>
        <button onclick="paResetForm()" style="background:#2a2d3a;color:#ccc;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Clear</button>
        <span id="paMsg" style="align-self:center;font-size:0.78rem;"></span>
      </div>
    </div>
    <div id="paList" style="font-size:0.85rem;"></div>
  </div>
</div>
<script>
  var PA_GROUPS = ${JSON.stringify(GROUPS.map(g => g.label))};
  var PA_PRODUCTS = ${JSON.stringify(productMapping.map(p => p.name))};
  var _paEditing = null;
  var _paChanged = false;
  function openPeopleAdmin(){
    var sel = document.getElementById('paGroup');
    sel.innerHTML = PA_GROUPS.map(function(g){ return '<option>' + g + '</option>'; }).join('');
    document.getElementById('paProducts').innerHTML = PA_PRODUCTS.map(function(p,i){
      return '<label style="font-size:0.72rem;color:#cdd;background:#0d0e14;border:1px solid #2a2d3a;border-radius:6px;padding:4px 8px;cursor:pointer;"><input type="checkbox" class="pa-prod" value="' + p + '"> ' + p + '</label>';
    }).join('');
    paResetForm();
    document.getElementById('peopleAdminModal').style.display = 'block';
    paLoad();
  }
  function closePeopleAdmin(){ if (_paChanged) { location.reload(); return; } document.getElementById('peopleAdminModal').style.display = 'none'; }
  function paResetForm(){
    _paEditing = null;
    document.getElementById('paName').value = '';
    document.getElementById('paName').readOnly = false;
    document.getElementById('paColor').value = '#8888aa';
    document.querySelectorAll('.pa-prod').forEach(function(c){ c.checked = false; });
    var pg = document.getElementById('paGroup'); if (pg) pg.selectedIndex = 0;
    document.getElementById('paSaveBtn').textContent = 'Add';
    document.getElementById('paMsg').textContent = '';
  }
  function paSetMsg(t, okFlag){ var m = document.getElementById('paMsg'); m.textContent = t; m.style.color = okFlag ? '#69c56e' : '#ff6b6b'; }
  function paEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function paLoad(){
    fetch('/api/admin/people').then(function(r){ return r.json(); }).then(function(d){
      if (!d.people) { document.getElementById('paList').textContent = 'Load error'; return; }
      var html = '';
      d.people.forEach(function(p){
        var prods = (p.products || []).length;
        var safeColor = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#888';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #1e2030;">'
          + '<span style="width:12px;height:12px;border-radius:50%;background:' + safeColor + ';flex-shrink:0;"></span>'
          + '<span style="flex:1;">' + paEsc(p.name) + ' <span style="color:#667;">· ' + paEsc(p.group) + ' · ' + prods + ' prod.</span></span>'
          + '<button onclick=\\'paEdit(' + JSON.stringify(p).replace(/'/g, "&#39;") + ')\\' style="background:#2a2d3a;color:#bbb;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:0.72rem;">Edit</button>'
          + '<button onclick=\\'paRemove(' + JSON.stringify(p.name).replace(/'/g, "&#39;") + ')\\' style="background:rgba(255,68,68,0.12);color:#ff8a8a;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:0.72rem;">Remove</button>'
          + '</div>';
      });
      document.getElementById('paList').innerHTML = html;
    }).catch(function(e){ document.getElementById('paList').textContent = 'Error: ' + e.message; });
  }
  function paEdit(p){
    _paEditing = p.name;
    document.getElementById('paName').value = p.name;
    document.getElementById('paName').readOnly = true;
    document.getElementById('paGroup').value = p.group;
    document.getElementById('paColor').value = (/^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#8888aa');
    var set = {}; (p.products || []).forEach(function(x){ set[x] = true; });
    document.querySelectorAll('.pa-prod').forEach(function(c){ c.checked = !!set[c.value]; });
    document.getElementById('paSaveBtn').textContent = 'Save changes';
    paSetMsg('Editing: ' + p.name, true);
  }
  function paSave(){
    var name = document.getElementById('paName').value.trim();
    var group = document.getElementById('paGroup').value;
    var color = document.getElementById('paColor').value;
    var products = Array.prototype.slice.call(document.querySelectorAll('.pa-prod:checked')).map(function(c){ return c.value; });
    if (!name) { paSetMsg('Enter a name', false); return; }
    var url = _paEditing ? '/api/admin/people/update' : '/api/admin/people';
    document.getElementById('paSaveBtn').disabled = true;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, group: group, color: color, products: products }) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        document.getElementById('paSaveBtn').disabled = false;
        if (!res.ok) { paSetMsg('Error: ' + (res.j.error || 'unknown'), false); return; }
        _paChanged = true; paSetMsg('Saved', true); paResetForm(); paLoad();
      }).catch(function(e){ document.getElementById('paSaveBtn').disabled = false; paSetMsg('Error: ' + e.message, false); });
  }
  function paRemove(name){
    if (!confirm('Remove ' + name + '?')) return;
    fetch('/api/admin/people/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){ if (!res.ok) { paSetMsg('Error: ' + (res.j.error || ''), false); return; } _paChanged = true; paSetMsg('Removed', true); paResetForm(); paLoad(); })
      .catch(function(e){ paSetMsg('Error: ' + e.message, false); });
  }
</script>
<script>
(function(){
  // Phase 5: multi-select + bulk delete (timeline view). Ctrl/Cmd+click on a pill = select.
  var sel={};
  function cnt(){ return Object.keys(sel).length; }
  function mark(el,on){ el.style.outline=on?'3px solid #ffd54f':''; el.style.outlineOffset=on?'-1px':''; }
  function ensureBar(){
    var b=document.getElementById('yggBulkBar');
    if(b) return b;
    b=document.createElement('div'); b.id='yggBulkBar';
    b.style.cssText='position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:4000;background:#13141c;border:1px solid #2a2d3a;border-radius:12px;padding:10px 14px;display:none;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,0.5);font-size:0.85rem;color:#dfe6f2;';
    var c=document.createElement('span'); c.id='yggBulkCount';
    var d=document.createElement('button'); d.textContent='Delete selected'; d.style.cssText='background:#e05260;color:#fff;border:none;padding:7px 14px;border-radius:7px;cursor:pointer;font-weight:bold;'; d.addEventListener('click',doDelete);
    var x=document.createElement('button'); x.textContent='Clear'; x.style.cssText='background:#2a2d3a;color:#ccc;border:none;padding:7px 12px;border-radius:7px;cursor:pointer;'; x.addEventListener('click',clearSel);
    b.appendChild(c); b.appendChild(d); b.appendChild(x);
    document.body.appendChild(b);
    return b;
  }
  function refresh(){ var b=ensureBar(),c=cnt(); b.style.display=c?'flex':'none'; var cs=document.getElementById('yggBulkCount'); if(cs) cs.textContent=c+' selected'; }
  function toggleId(id,sht,snm){
    if(!id) return;
    if(sel[id]){ sel[id].els.forEach(function(e){mark(e,false);}); delete sel[id]; }
    else {
      var els=Array.prototype.slice.call(document.querySelectorAll('.shift-pill[data-sid="'+id+'"]'));
      els.forEach(function(e){mark(e,true);});
      sel[id]={ id:id, sht:sht||'', snm:snm||'', els:els };
    }
    refresh();
  }
  function clearSel(){ Object.keys(sel).forEach(function(k){ sel[k].els.forEach(function(e){mark(e,false);}); }); sel={}; refresh(); }
  function doDelete(){
    var keys=Object.keys(sel); if(!keys.length) return;
    if(!confirm('Delete '+keys.length+' selected shift(s)? This cannot be undone.')) return;
    var items=keys.map(function(k){ return { id:sel[k].id, sheetTitle:sel[k].sht, name:sel[k].snm }; });
    fetch('/api/bulk-delete',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({items:items}) })
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){ if(!res.ok){ alert('Error: '+(res.j.error||'unknown')); return; } location.reload(); })
      .catch(function(e){ alert('Error: '+e.message); });
  }
  function toast(msg){
    var t=document.getElementById('yggToast');
    if(!t){ t=document.createElement('div'); t.id='yggToast'; t.style.cssText='position:fixed;bottom:74px;left:50%;transform:translateX(-50%);z-index:4100;background:#3a2030;border:1px solid #6b3a4a;color:#ffd0d8;padding:8px 14px;border-radius:8px;font-size:0.8rem;box-shadow:0 4px 16px rgba(0,0,0,0.5);transition:opacity 0.3s;'; document.body.appendChild(t); }
    t.textContent=msg; t.style.opacity='1'; clearTimeout(t._h); t._h=setTimeout(function(){ t.style.opacity='0'; },2200);
  }

  // ====== Swap board (shift swap requests) ======
  window.__swapOpen = false;
  function openSwapBoard(){
    var ov = document.getElementById('swapOverlay');
    if(!ov){
      ov = document.createElement('div'); ov.id='swapOverlay';
      ov.style.cssText='position:fixed;inset:0;z-index:4200;background:rgba(0,0,0,0.6);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;';
      ov.addEventListener('click', function(e){ if(e.target===ov) closeSwapBoard(); });
      var box=document.createElement('div'); box.style.cssText='max-width:720px;width:100%;background:var(--bg1);border:1px solid var(--gborder);border-radius:14px;padding:22px;';
      var head=document.createElement('div'); head.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;';
      var h2=document.createElement('h2'); h2.style.cssText='margin:0;color:var(--au1);font-size:1.2rem;'; h2.textContent='🔄 Shift swaps';
      var xb=document.createElement('button'); xb.textContent='×'; xb.style.cssText='background:none;border:none;color:var(--tmid);font-size:1.4rem;cursor:pointer;'; xb.addEventListener('click', closeSwapBoard);
      head.appendChild(h2); head.appendChild(xb);
      var bodyD=document.createElement('div'); bodyD.id='swapBody'; bodyD.style.cssText='color:var(--tmid);'; bodyD.textContent='Loading…';
      box.appendChild(head); box.appendChild(bodyD); ov.appendChild(box); document.body.appendChild(ov);
    }
    ov.style.display='flex'; window.__swapOpen=true; loadSwapBoard();
  }
  function closeSwapBoard(){ var ov=document.getElementById('swapOverlay'); if(ov) ov.style.display='none'; window.__swapOpen=false; }
  window.loadSwapBoard=function(){
    fetch('/api/swaps').then(function(r){return r.json();}).then(function(d){
      var b=d.board||{}; var body=document.getElementById('swapBody'); if(!body) return; body.innerHTML='';
      function makeBtn(label,color,fn){ var x=document.createElement('button'); x.textContent=label; x.style.cssText='background:'+color+'22;border:1px solid '+color+'66;color:'+color+';border-radius:6px;padding:5px 11px;font-weight:700;cursor:pointer;font-size:0.74rem;margin-right:6px;'; x.addEventListener('click',fn); return x; }
      function makeCard(r,btns){ var c=document.createElement('div'); c.style.cssText='border:1px solid var(--gborder);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--bg0);'; var t=document.createElement('div'); t.style.cssText='font-weight:700;color:var(--thi);'; t.textContent=r.ShiftProduct+' · '+r.ShiftDate+' · '+r.ShiftStart+'-'+r.ShiftEnd; var sub=document.createElement('div'); sub.style.cssText='font-size:0.8rem;color:var(--tmid);margin:3px 0;'; sub.textContent='Offered by: '+r.RequesterName+(r.ClaimedBy?(' → '+r.ClaimedBy):'')+(r.Note?(' · '+r.Note):''); var ba=document.createElement('div'); btns.forEach(function(x){ba.appendChild(x);}); c.appendChild(t); c.appendChild(sub); c.appendChild(ba); return c; }
      function section(title,color){ var h=document.createElement('div'); h.style.cssText='font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:'+color+';margin:12px 0 6px;'; h.textContent=title; body.appendChild(h); }
      var toApprove=b.toApprove||[],open=b.open||[],mine=b.mine||[];
      if(toApprove.length){ section('To approve','#a78bfa'); toApprove.forEach(function(r){ body.appendChild(makeCard(r,[makeBtn('✓ Approve','#4caf50',function(){swapAction(r.Id,'approve');}),makeBtn('Cancel','#e05260',function(){swapAction(r.Id,'cancel');})])); }); }
      section('Open offers ('+open.length+')','#5b7fa6');
      if(open.length){ open.forEach(function(r){ body.appendChild(makeCard(r,[makeBtn('✋ Take','#64b5f6',function(){swapAction(r.Id,'claim');})])); }); }
      else { var em=document.createElement('div'); em.style.cssText='color:var(--tlo);font-size:0.85rem;'; em.textContent='No open offers.'; body.appendChild(em); }
      if(mine.length){ section('My requests','#5b7fa6'); mine.forEach(function(r){ body.appendChild(makeCard(r,[makeBtn('Cancel','#e05260',function(){swapAction(r.Id,'cancel');})])); }); }
    }).catch(function(err){ var body=document.getElementById('swapBody'); if(body) body.textContent='Error: '+err.message; });
  };
  window.swapAction=function(id,act){
    fetch('/api/swaps/'+id+'/'+act,{method:'POST'}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(x){
      if(!x.ok){ toast('Error: '+((x.j&&x.j.error)||'?')); return; }
      toast(act==='approve'?'Swap approved ✓':act==='claim'?'Taken ✋':'Done'); loadSwapBoard();
    }).catch(function(e){ toast('Error: '+e.message); });
  };
  window.requestSwapFromModal=function(){
    var s=_currentShiftSource; if(!s){ toast('No shift selected'); return; }
    var note=prompt('Note for the swap (optional):','')||'';
    fetch('/api/swaps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:s.name,date:s.date,product:s.product,start:s.start,end:s.end,trading:s.trading,note:note,sheet:s.sheetTitle,row:s.row,col:s.col,msId:(s.sheetTitle==='ManualShifts'?s.id:'')})})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(x){
        if(!x.ok){ toast('Error: '+((x.j&&x.j.error)||'?')); return; }
        toast('Swap request created 🔄'); if(typeof closeModal==='function') closeModal();
      }).catch(function(e){ toast('Error: '+e.message); });
  };

  // Volano z openViewModal pri Ctrl/Cmd+kliku (neotevira modal). Vybira jen ManualShifts (maji Id).
  window.yggBulkClick=function(name, sheetTitle, id, targetEl){
    var pill=(targetEl && targetEl.closest)?targetEl.closest('.shift-pill'):null;
    if(sheetTitle==='ManualShifts' && id){
      toggleId(id, sheetTitle, name||'');
    } else {
      if(pill){ pill.style.outline='3px solid #e05260'; setTimeout(function(){ pill.style.outline=''; },500); }
      toast('Bulk delete is only possible for manually added shifts (ManualShifts).');
    }
  };
})();
</script>
<script>
(function(){
  // Phase 4: per-user ordering of timeline rows (localStorage ygg_order_*). Self-contained.
  function getOrder(k){ try{ return (localStorage.getItem(k)||'').split('||').filter(Boolean);}catch(e){return [];} }
  function setOrder(k,a){ try{ localStorage.setItem(k,a.join('||'));}catch(e){} }
  function reorderBySaved(cur,saved){
    var curSet={}; cur.forEach(function(k){curSet[k]=1;});
    var seen={},out=[];
    saved.forEach(function(k){ if(curSet[k]&&!seen[k]){out.push(k);seen[k]=1;} });
    cur.forEach(function(k){ if(!seen[k]){out.push(k);seen[k]=1;} });
    return out;
  }
  var ROWS=[
    { sel:'.timeline-row.user-row', attr:'data-name', key:'ygg_order_names' },
    { sel:'.timeline-row.product-row', attr:'data-product-row', key:'ygg_order_prods' }
  ];
  function applyOrder(cfg){
    var rows=Array.prototype.slice.call(document.querySelectorAll(cfg.sel));
    if(!rows.length) return;
    var groups=[];
    rows.forEach(function(r){ var p=r.parentNode,g=null; for(var i=0;i<groups.length;i++){if(groups[i].p===p){g=groups[i];break;}} if(!g){g={p:p,rows:[]};groups.push(g);} g.rows.push(r); });
    var saved=getOrder(cfg.key);
    groups.forEach(function(g){
      var keys=g.rows.map(function(r){return r.getAttribute(cfg.attr);});
      reorderBySaved(keys,saved).forEach(function(k){
        for(var i=0;i<g.rows.length;i++){ if(g.rows[i].getAttribute(cfg.attr)===k){ g.p.appendChild(g.rows[i]); break; } }
      });
    });
  }
  function rowSiblings(row,cfg){ var p=row.parentNode,out=[]; Array.prototype.slice.call(p.children).forEach(function(ch){ if(ch.classList&&ch.classList.contains('timeline-row')&&ch.getAttribute(cfg.attr)!=null) out.push(ch); }); return out; }
  function saveCurrent(cfg){ var rows=Array.prototype.slice.call(document.querySelectorAll(cfg.sel)),keys=[]; rows.forEach(function(r){var k=r.getAttribute(cfg.attr); if(k&&keys.indexOf(k)<0)keys.push(k);}); setOrder(cfg.key,keys); }
  function move(row,cfg,dir){
    var p=row.parentNode,sib=rowSiblings(row,cfg),i=sib.indexOf(row),j=i+dir;
    if(i<0||j<0||j>=sib.length) return;
    if(dir<0) p.insertBefore(row,sib[j]); else p.insertBefore(row,sib[j].nextSibling);
    saveCurrent(cfg);
  }
  function mkBtn(t){ var b=document.createElement('button'); b.textContent=t; b.className='ygg-ord-btn'; b.style.cssText='background:#2a2d3a;color:#bbb;border:none;border-radius:4px;cursor:pointer;font-size:0.7rem;line-height:1;padding:2px 5px;margin-right:3px;pointer-events:auto;'; return b; }
  var editing=false;
  function addControls(){
    ROWS.forEach(function(cfg){
      Array.prototype.slice.call(document.querySelectorAll(cfg.sel)).forEach(function(row){
        if(row.querySelector('.ygg-ord-wrap')) return;
        var wrap=document.createElement('span'); wrap.className='ygg-ord-wrap'; wrap.style.cssText='position:sticky;left:150px;z-index:30;pointer-events:auto;white-space:nowrap;';
        var up=mkBtn('▲'),dn=mkBtn('▼');
        up.addEventListener('click',function(ev){ev.stopPropagation();move(row,cfg,-1);});
        dn.addEventListener('click',function(ev){ev.stopPropagation();move(row,cfg,1);});
        wrap.appendChild(up);wrap.appendChild(dn);
        var label=row.querySelector('div'); if(label) label.insertBefore(wrap,label.firstChild); else row.insertBefore(wrap,row.firstChild);
      });
    });
  }
  function removeControls(){ Array.prototype.slice.call(document.querySelectorAll('.ygg-ord-wrap')).forEach(function(w){ if(w.parentNode) w.parentNode.removeChild(w); }); }
  function toggleMode(){ editing=!editing; if(editing) addControls(); else removeControls(); var t=document.getElementById('yggOrdToggle'); if(t) t.style.background=editing?'#7e57c2':'#2a2d3a'; }
  function init(){
    ROWS.forEach(applyOrder);
    var t=document.createElement('button'); t.id='yggOrdToggle'; t.title='Reorder rows (per-user)'; t.textContent='⇅';
    t.style.cssText='position:fixed;bottom:74px;right:20px;z-index:3500;background:#2a2d3a;color:#fff;border:1px solid #444;border-radius:50%;width:42px;height:42px;font-size:1.1rem;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.4);';
    t.addEventListener('click',toggleMode);
    document.body.appendChild(t);
  }
  if(document.readyState==='complete') init(); else window.addEventListener('load',init);
})();
</script>
</body>
</html>`);
    } catch (e) { res.status(500).send("Dashboard Error: "+e.message); }
});

// POST /api/commit-to-schedule
// Body: { month: "July 2026", product: "Valhalla Cup A", shifts: [{date, slotIndex, person}, ...], overwrite: false }
// Mirrors the logic of scripts/commit-to-schedule.js, but as a UI endpoint.
app.post('/api/commit-to-schedule', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const { month: monthLabel, product, shifts, overwrite } = req.body || {};
    if (!monthLabel || !product || !Array.isArray(shifts)) {
        return res.status(400).json({ error: 'Missing month, product, or shifts array' });
    }

    function colToLetter(c) {
        let s = ''; let n = c + 1;
        while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
        return s;
    }
    function isOvernight(slot) {
        const sh = parseInt(slot.s.split(':')[0]); const eh = parseInt(slot.e.split(':')[0]);
        return sh >= 20 && eh < 12;
    }
    function addDays(iso, n) {
        const d = new Date(iso + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }

    try {
        await doc.loadInfo();
        const sheetTitle = 'Schedule - ' + monthLabel;
        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) {
            const avail = Object.keys(doc.sheetsByTitle).filter(t => t.startsWith('Schedule -'));
            return res.status(404).json({ error: 'Sheet "' + sheetTitle + '" not found', available: avail });
        }
        const pm = productMapping.find(p => p.name === product);
        if (!pm) return res.status(400).json({ error: 'Unknown product: ' + product });

        const maxRow = Math.min(sheet.rowCount, 500);
        const lastSlotCol = pm.startCol + Math.max(...pm.slots.map(s => s.o));
        await sheet.loadCells('A1:' + colToLetter(lastSlotCol) + maxRow);

        const dateToRow = new Map();
        for (let r = 0; r < maxRow; r++) {
            const cell = sheet.getCell(r, 0);
            const iso = convertCzechDate(cell.formattedValue || cell.value);
            if (iso) dateToRow.set(iso, r);
        }

        const actions = { WRITE: 0, OVERWRITE: 0, SAME: 0, CONFLICT: 0 };
        const skipped = [];
        const planned = [];

        for (const s of shifts) {
            const slot = pm.slots[s.slotIndex];
            if (!slot) { skipped.push({ shift: s, reason: 'bad slotIndex' }); continue; }
            const sheetDate = isOvernight(slot) ? addDays(s.date, 1) : s.date;
            const row = dateToRow.get(sheetDate);
            if (row === undefined) { skipped.push({ shift: s, reason: 'sheet date ' + sheetDate + ' not in sheet' }); continue; }
            const col = pm.startCol + slot.o;
            const cell = sheet.getCell(row, col);
            const cur = cell.value;
            let action;
            if (cur == null || cur === '' || cur === '-') action = 'WRITE';
            else if (String(cur).trim() === s.person) action = 'SAME';
            else if (overwrite) action = 'OVERWRITE';
            else action = 'CONFLICT';
            actions[action]++;
            planned.push({ row, col, sheetDate, slotIndex: s.slotIndex, person: s.person, currentValue: String(cur || ''), action });
        }

        // Pokud konflikty bez overwrite, neuloz nic a vrat plan
        const conflictsCount = actions.CONFLICT;
        if (conflictsCount > 0 && !overwrite) {
            return res.json({
                ok: false, dryRun: true, monthLabel, product, sheetTitle,
                actions, skipped: skipped.length, conflicts: conflictsCount,
                conflictDetails: planned.filter(p => p.action === 'CONFLICT').slice(0, 20),
                skippedDetails: skipped.slice(0, 20)
            });
        }

        // Commit
        let written = 0;
        for (const p of planned) {
            if (p.action === 'SAME') continue;
            const cell = sheet.getCell(p.row, p.col);
            cell.value = p.person;
            written++;
        }
        if (written > 0) await sheet.saveUpdatedCells();

        // Invalidate cache so dashboard refresh pulls new data
        if (typeof invalidateCache === 'function') invalidateCache();

        // Audit log
        try {
            const auditSheet = doc.sheetsByTitle['AuditLog'];
            if (auditSheet) {
                await auditSheet.addRow({
                    Timestamp: new Date().toISOString(),
                    Jmeno: req.user.jmeno || req.user.email,
                    Event: 'AI_GENERATE_COMMIT',
                    Detail: monthLabel + '|' + product + '|written=' + written + '|overwrite=' + !!overwrite
                });
            }
        } catch(_) { /* audit nepovinny */ }

        res.json({
            ok: true, dryRun: false, monthLabel, product, sheetTitle,
            written, actions, skipped: skipped.length,
            skippedDetails: skipped.slice(0, 20)
        });
    } catch(e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// Sentry error handler — after all routes; no-op without SENTRY_DSN env
if (process.env.SENTRY_DSN) { try { Sentry.setupExpressErrorHandler(app); } catch (e) { console.error('Sentry express handler failed:', e.message); } }

// Pouze pokud je tento soubor spousten primo (node index.js), nikoli require()
if (require.main === module) {
    app.listen(PORT, () => {
        console.log('Drachir.gg active');
        refreshPeopleFromSheet().catch(e => console.error('[PEOPLE] Startup load failed, using seed:', e.message));
        setInterval(() => { refreshPeopleFromSheet().catch(() => {}); }, 5 * 60 * 1000);
        refreshProductsFromSheet().catch(e => console.error('[PRODUCTS] Startup load failed, using seed:', e.message));
        setInterval(() => { refreshProductsFromSheet().catch(() => {}); }, 5 * 60 * 1000);
        // PERF: nahrej cache smen pri startu + drz ji teplou (prewarm kazde 4 min < 5min TTL) — uzivatel necaka na cold load
        loadAllShifts(false).catch(e => console.error('[SHIFTS] Startup warm failed:', e.message));
        setInterval(() => { loadAllShifts(false, { refresh: true }).catch(() => {}); }, 4 * 60 * 1000);
        loadSlackData().catch(e => console.error('Initial Slack data load failed:', e.message));
        if (BAMBOOHR_API_KEY && BAMBOOHR_SUBDOMAIN) {
            setTimeout(() => {
                syncBambooVacations(true).then(r => {
                    console.log('[BAMBOO] Startup sync: +' + r.added + ' / -' + r.removed + (r.error ? ' error=' + r.error : ''));
                    invalidateCache();
                }).catch(e => console.error('[BAMBOO] Startup sync error:', e.message));
            }, 5000);
        }
    });
}

// Export pro standalone skripty (scripts/preview-prompt.js)
module.exports = {
    peopleHierarchy,
    personColors,
    doc,
    loadCapabilities,
    loadAllShifts,
    buildGeneratorPrompt,
    validateGeneratedSchedule,
    callClaude,
    parseMonthLabel,
    getMonthDates,
    getProductMeta,
    getCoverageProfile,
    productMapping,
    productColors,
    productCoverage
};
