# Fáze 1 — Bezpečný základ: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zabezpečit muj-kalendar (hashování hesel, CSRF, secret do env), dát směnám stabilní UUID, odstranit duplicitní seznam produktů, hlídat zpětné uvozovky a přidat adminovi prohlížečku audit logu — bez dotyku hardcoded dat lidí/produktů (to řeší Fáze 2).

**Architecture:** Monolitický `index.js` (~6100 řádků) zůstává. Čisté, testovatelné funkce se vyčlení do `lib/` (existující vzor, viz `lib/local-solver.js`) a unit-testují node skripty v `scripts/` (vzor `scripts/test-*.js`). Změny rout/Sheets se ověřují manuálně/`curl` (projekt nemá test framework — CLAUDE.md, a spec to potvrzuje).

**Tech Stack:** Node.js 20+, Express, express-session, `crypto` (vestavěné — scrypt, randomUUID, randomBytes, timingSafeEqual), google-spreadsheet. Žádná nová npm závislost.

---

## Poznámka k testování (čti první)

Projekt **nemá** jest/pytest (CLAUDE.md: "No build step, no tests, no linter"). Uživatelská instrukce má přednost před default TDD. Proto:

- **Pravé unit testy** (test-first) píšeme pro čisté funkce: `lib/auth.js`, `lib/validate.js` → assert-based node skripty v `scripts/`.
- **Integrační změny** (login, CSRF, UUID v routách, audit) ověřujeme **manuálně** přesnými kroky + `curl`, podle acceptance criteria ve specu.
- **Po každé změně template literalu** ověř platnost klientského JS (CLAUDE.md): viz „Verifikace JS" na konci.
- **Na Windows před každým restartem** serveru: `taskkill //F //IM node.exe` (CLAUDE.md — orphan procesy na portu 3000).

Spec: [docs/superpowers/specs/2026-06-16-faze1-bezpecny-zaklad-design.md](../specs/2026-06-16-faze1-bezpecny-zaklad-design.md)

---

## File Structure

| Soubor | Odpovědnost | Akce |
|--------|-------------|------|
| `lib/auth.js` | scrypt hash/verify hesla (čisté funkce) | Create |
| `lib/validate.js` | validace zpětných uvozovek / `${` | Create |
| `scripts/test-auth.js` | unit testy pro lib/auth.js | Create |
| `scripts/test-validate.js` | unit testy pro lib/validate.js | Create |
| `scripts/backfill-shift-ids.js` | jednorázové doplnění `Id` do ManualShifts | Create |
| `index.js` | napojení helperů, CSRF, secret→env, UUID v routách, dedup, audit route | Modify |
| `render.yaml` | env proměnná `SESSION_SECRET` | Modify |

---

## Task 1: `lib/auth.js` — scrypt hashování hesla

**Files:**
- Create: `lib/auth.js`
- Test: `scripts/test-auth.js`

- [ ] **Step 1: Napiš padající test** — `scripts/test-auth.js`

```js
const assert = require('assert');
const { hashPassword, verifyPassword } = require('../lib/auth');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// 1) hash má očekávaný formát scrypt$salt$hash
const h = hashPassword('TajneHeslo123');
assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, 'formát hashe');
ok('hashPassword vrací scrypt$salt$hash');

// 2) stejné heslo dvakrát => různý hash (kvůli soli)
assert.notStrictEqual(h, hashPassword('TajneHeslo123'), 'sůl se liší');
ok('dva hashe stejného hesla se liší');

// 3) verify správného hesla proti hashi
let r = verifyPassword('TajneHeslo123', h);
assert.strictEqual(r.ok, true);  assert.strictEqual(r.legacy, false);
ok('verify správného hesla proti hashi');

// 4) verify špatného hesla proti hashi
r = verifyPassword('Spatne', h);
assert.strictEqual(r.ok, false);
ok('verify špatného hesla selže');

// 5) legacy plaintext — shoda
r = verifyPassword('plain', 'plain');
assert.strictEqual(r.ok, true);  assert.strictEqual(r.legacy, true);
ok('legacy plaintext shoda => ok+legacy');

// 6) legacy plaintext — neshoda
r = verifyPassword('plain', 'jine');
assert.strictEqual(r.ok, false);
ok('legacy plaintext neshoda => false');

console.log('\nVŠECHNY TESTY OK (' + n + ')');
```

- [ ] **Step 2: Spusť test, ověř že padá**

Run: `node scripts/test-auth.js`
Expected: FAIL — `Cannot find module '../lib/auth'`

- [ ] **Step 3: Implementuj `lib/auth.js`**

```js
const crypto = require('crypto');

const KEYLEN = 64;
const SALTLEN = 16;
const PREFIX = 'scrypt';

// Vrátí "scrypt$<saltHex>$<hashHex>"
function hashPassword(plain) {
    const salt = crypto.randomBytes(SALTLEN);
    const hash = crypto.scryptSync(String(plain), salt, KEYLEN);
    return PREFIX + '$' + salt.toString('hex') + '$' + hash.toString('hex');
}

// Vrátí { ok: bool, legacy: bool }.
// legacy=true znamená, že stored bylo plaintext (volající ho má upgradovat).
function verifyPassword(plain, stored) {
    if (typeof stored !== 'string') return { ok: false, legacy: false };
    if (!stored.startsWith(PREFIX + '$')) {
        // legacy plaintext porovnání
        return { ok: String(plain) === stored, legacy: true };
    }
    const parts = stored.split('$');
    if (parts.length !== 3) return { ok: false, legacy: false };
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(plain), salt, KEYLEN);
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    return { ok, legacy: false };
}

module.exports = { hashPassword, verifyPassword };
```

- [ ] **Step 4: Spusť test, ověř že prochází**

Run: `node scripts/test-auth.js`
Expected: PASS — `VŠECHNY TESTY OK (6)`

- [ ] **Step 5: Commit**

```bash
git add lib/auth.js scripts/test-auth.js
git commit -m "feat(auth): scrypt password hashing helpers + tests"
```

---

## Task 2: Napojit hashování + líná migrace do loginu a change-password

**Files:**
- Modify: `index.js` (import nahoře; login `:1254-1267`; change-password `:1463-1475`)

- [ ] **Step 1: Přidej import** hned za stávající `const crypto = require('crypto');` (`index.js:5`)

```js
const { hashPassword, verifyPassword } = require('./lib/auth');
```

- [ ] **Step 2: Uprav login matching** — v `index.js` najdi smyčku na `:1254-1267`. Nahraď blok hledání uživatele tímto (heslo se ověří přes `verifyPassword`, řádek + index se zapamatuje kvůli líné migraci):

```js
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
```

- [ ] **Step 3: Uprav change-password** — v `index.js:1464-1475` nahraď porovnání starého hesla a zápis nového:

```js
            if (email === userEmail) {
                const v = verifyPassword(currentPassword.trim(), heslo);
                if (!v.ok) return res.redirect('/change-password?error=wrong');
                userRow = r;
                break;
            }
```

a zápis nového hesla (`:1474`):

```js
        // Zapis nove heslo (hashovane)
        sheet.getCell(userRow, colHeslo).value = hashPassword(newPassword.trim());
        await sheet.saveUpdatedCells();
```

- [ ] **Step 4: Manuální ověření**

```bash
taskkill //F //IM node.exe   # ignoruj chybu pokud neběží
node index.js
```
1. V prohlížeči `http://localhost:3000`, přihlas se existujícím účtem (stejné heslo jako dřív) → musí projít na `/dashboard`.
2. V Google Sheetu `uzivatele` zkontroluj, že buňka `heslo` toho účtu je teď `scrypt$...`.
3. Odhlas se a přihlas znovu stejným heslem → musí projít (teď už přes hash, ne legacy).
4. Špatné heslo → `/?error=1`.

Expected: vše dle bodů 1–4.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(auth): hash passwords on login/change-password with lazy migration"
```

---

## Task 3: Tajný klíč do env + render.yaml

**Files:**
- Modify: `index.js:12`
- Modify: `render.yaml`

- [ ] **Step 1: Uprav secret** — `index.js:12`:

```js
const COOKIE_SECRET = process.env.SESSION_SECRET || 'drachir-viking-secret-2026';
```

- [ ] **Step 2: Přidej env do `render.yaml`** — do sekce `envVars` služby přidej:

```yaml
      - key: SESSION_SECRET
        sync: false
```

- [ ] **Step 3: Ověř boot lokálně (fallback)**

```bash
taskkill //F //IM node.exe
node index.js
```
Expected: server naběhne, login + dashboard fungují (fallback secret, bez env).

- [ ] **Step 4: Ověř s env**

```bash
taskkill //F //IM node.exe
SESSION_SECRET=test-local-secret node index.js
```
Expected: naběhne; po přihlášení funguje. (Pozn.: změna secretu zneplatní staré session/remember cookies — nutné se znovu přihlásit. Při nasazení na Render dát týmu echo.)

- [ ] **Step 5: Commit**

```bash
git add index.js render.yaml
git commit -m "feat(security): move session secret to SESSION_SECRET env var"
```

---

## Task 4: CSRF ochrana

**Files:**
- Modify: `index.js` (middleware za session `:18` a za body-parsery `:56`; dashboard `<head>`; change-password page+form `:1396`)

- [ ] **Step 1: Přidej token-ensure middleware** hned za `app.use(session({...}))` (po `index.js:18`):

```js
// CSRF: zajisti token v session
app.use((req, res, next) => {
    if (req.session && !req.session.csrf) {
        req.session.csrf = crypto.randomBytes(32).toString('hex');
    }
    next();
});
```

- [ ] **Step 2: Přidej verify middleware** hned za body-parsery (po `app.use(express.json());` na `index.js:56`):

```js
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
```

- [ ] **Step 3: Vlož meta tag + fetch wrapper do dashboardu** — najdi `<head>` v template literalu dashboardu (grep `'<head>'` uvnitř GET /dashboard, kolem `:3050`). Hned za `<head>` vlož:

```html
<meta name="csrf-token" content="${req.session.csrf}">
<script>
(function(){
  var meta = document.querySelector('meta[name="csrf-token"]');
  var _csrf = meta ? meta.content : '';
  var _origFetch = window.fetch;
  window.fetch = function(url, opts){
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      opts.headers = Object.assign({}, opts.headers || {}, { 'X-CSRF-Token': _csrf });
    }
    return _origFetch(url, opts);
  };
})();
</script>
```

> Pozor: tento `<script>` NESMÍ obsahovat `${` (rozbilo by server-side interpolaci). Výše uvedený kód žádné `${` nemá — `${req.session.csrf}` je záměrná server-side interpolace v meta tagu.

- [ ] **Step 4: Ošetři change-password form** — najdi GET render change-password stránky (kolem `:1380`). Do jejího `<head>` přidej `<meta name="csrf-token" content="${req.session.csrf}">`. Do formuláře `<form action="/change-password" method="POST" id="pwdForm">` (`:1396`) přidej hned za otevírací tag skrytý input:

```html
<input type="hidden" name="_csrf" value="${req.session.csrf}">
```

- [ ] **Step 5: Manuální + curl ověření**

```bash
taskkill //F //IM node.exe
node index.js
```
1. Přihlas se, otevři dashboard, přidej/uprav/smaž směnu → musí fungovat (fetch dostává header automaticky).
2. Změna hesla přes formulář → funguje (hidden `_csrf`).
3. POST bez tokenu musí selhat:
```bash
curl -i -X POST http://localhost:3000/add-shift -H "Content-Type: application/json" -d "{}"
```
Expected: `HTTP/1.1 403` + `CSRF token invalid`.

- [ ] **Step 6: Verifikace JS** (viz sekce na konci) + Commit

```bash
git add index.js
git commit -m "feat(security): CSRF token protection on state-changing requests"
```

---

## Task 5: `lib/validate.js` — validace zpětných uvozovek

**Files:**
- Create: `lib/validate.js`
- Test: `scripts/test-validate.js`

- [ ] **Step 1: Napiš padající test** — `scripts/test-validate.js`

```js
const assert = require('assert');
const { validateNoTemplateChars } = require('../lib/validate');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// 1) čisté hodnoty projdou
assert.strictEqual(validateNoTemplateChars('Jan Novak', 'Poznamka'), null);
ok('čisté hodnoty => null');

// 2) zpětná uvozovka => chyba
assert.notStrictEqual(validateNoTemplateChars('a`b'), null);
ok('backtick => chyba');

// 3) ${ sekvence => chyba
assert.notStrictEqual(validateNoTemplateChars('x${y}'), null);
ok('${ => chyba');

// 4) ignoruje null/undefined/čísla
assert.strictEqual(validateNoTemplateChars(null, undefined, 42, 'ok'), null);
ok('null/undefined/číslo bezpečně ignorováno');

console.log('\nVŠECHNY TESTY OK (' + n + ')');
```

- [ ] **Step 2: Spusť test, ověř že padá**

Run: `node scripts/test-validate.js`
Expected: FAIL — `Cannot find module '../lib/validate'`

- [ ] **Step 3: Implementuj `lib/validate.js`**

```js
// Vrátí null pokud je vše v pořádku, jinak chybovou hlášku (string).
// Brání rozbití server-side template literalu zpětnou uvozovkou nebo ${ .
function validateNoTemplateChars(...values) {
    for (const v of values) {
        if (typeof v !== 'string') continue;
        if (v.includes('`') || v.includes('${')) {
            return 'Neplatný znak: hodnota nesmí obsahovat zpětnou uvozovku (`) ani ${';
        }
    }
    return null;
}

module.exports = { validateNoTemplateChars };
```

- [ ] **Step 4: Spusť test, ověř že prochází**

Run: `node scripts/test-validate.js`
Expected: PASS — `VŠECHNY TESTY OK (4)`

- [ ] **Step 5: Commit**

```bash
git add lib/validate.js scripts/test-validate.js
git commit -m "feat(validate): reject backtick/${ in user input + tests"
```

---

## Task 6: Napojit validaci do zápisových rout

**Files:**
- Modify: `index.js` (import `:6`; add-shift `:1988`; update-shift `:2068`; change-password `:1438`)

- [ ] **Step 1: Přidej import** za import auth (`index.js:6`):

```js
const { validateNoTemplateChars } = require('./lib/validate');
```

- [ ] **Step 2: add-shift** — hned za `if (!req.user) return res.status(401).send('Unauthorized');` (`:1988`):

```js
    const vErr = validateNoTemplateChars(req.body.name, req.body.product, req.body.trading, req.body.note, req.body.date);
    if (vErr) return res.status(400).json({ error: vErr });
```

- [ ] **Step 3: update-shift** — za `const { originalName, ... } = req.body;` (`:2069`):

```js
    const vErr = validateNoTemplateChars(name, product, trading, note, date);
    if (vErr) return res.status(400).json({ error: vErr });
```

- [ ] **Step 4: change-password** — za `const { currentPassword, newPassword, confirmPassword } = req.body;` (`:1438`):

```js
    const vErr = validateNoTemplateChars(newPassword);
    if (vErr) return res.redirect('/change-password?error=short');
```

- [ ] **Step 5: Manuální ověření**

```bash
taskkill //F //IM node.exe
node index.js
```
```bash
# nutný platný session+csrf; nejjednodušší přes UI: zkus přidat směnu se jménem obsahujícím ` 
# nebo přímý test ochrany (čekáme 403 kvůli CSRF, ne 400 — to potvrzuje, že middleware běží):
curl -i -X POST http://localhost:3000/add-shift -H "Content-Type: application/json" -d "{\"name\":\"a\`b\"}"
```
Expected (přes UI s platným tokenem): uložení směny se jménem obsahujícím `` ` `` vrátí 400 a stránka se nerozbije.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(validate): guard write endpoints against template-breaking chars"
```

---

## Task 7: UUID u směn (ManualShifts `Id`)

**Files:**
- Modify: `index.js` — add-shift `:1992-2005`; loadAllShifts `:636-668`; buildPersonPill `:3159-3161`; buildProdPill (`~:3271`, onclick na openViewModal); openViewModal `:4419,4474-4481`; deleteShift `:5086-5093`; delete-shift server `:2121-2135`; update-shift server `:2078-2083`

- [ ] **Step 1: add-shift generuje Id** — uprav vytvoření sheetu a addRow (`:1992-2005`):

```js
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
```

- [ ] **Step 2: loadAllShifts čte Id** — v ManualShifts smyčce přidej detekci sloupce a přenos do shift objektu. K detekci sloupců (`:636-645`) přidej:

```js
            let mColId=-1;
            for (let c = 0; c < 12; c++) {
                const v = manualSheet.getCell(0, c).value?.toString().trim().toLowerCase();
                if (v === 'id') mColId = c;
            }
```

a do `allShifts.push({...})` (`:656-668`) přidej pole:

```js
                    _id:    mColId >= 0 ? (manualSheet.getCell(r, mColId).value?.toString().trim() || null) : null,
```

- [ ] **Step 3: pilulky předají Id do modalu** — v `buildPersonPill` (`:3161`) na konec argumentů `openViewModal(...)` přidej `_id`. Najdi `+ (s._row||0) + ',' + (s._col||0) + ')">'` a nahraď:

```js
                     + ',' + (s._row||0) + ',' + (s._col||0) + ',\'' + (s._id||'') + '\')">'
```

Totéž proveď v `buildProdPill` (najdi tam stejné `openViewModal(...)` volání s `s._row`/`s._col` a přidej `,\'' + (s._id||'') + '\'` jako poslední argument před `)">`).

- [ ] **Step 4: openViewModal přijme a uloží id** — uprav signaturu (`:4419`):

```js
    function openViewModal(name,date,start,end,product,note,trading,personColor,prodColor,sheetTitle,row,col,id){
```

a do `_currentShiftSource` (`:4474-4481`) přidej pole:

```js
            id:         (id !== undefined && id !== null) ? id : '',
```

- [ ] **Step 5: deleteShift klient pošle id** — v `fetch('/delete-shift', ...)` body (`:5088-5093`) přidej:

```js
                        id:         _currentShiftSource.id || '',
```

- [ ] **Step 6: delete-shift server preferuje Id** — uprav blok ManualShifts (`:2117,2121-2135`). Rozšiř destrukturalizaci:

```js
    const { sheetTitle, row, col, name, id } = req.body;
```

a hledání řádku:

```js
            const manualSheet = doc.sheetsByTitle['ManualShifts'];
            if (manualSheet) {
                const rows = await manualSheet.getRows();
                let target = null;
                if (id) target = rows.find(r => (r.get('Id') || '') === id);
                if (!target) {
                    // fallback na starou shodu podle indexu řádku (řádky bez Id)
                    const rowIdx = parseInt(row);
                    target = rows.find((_r, i) => (i + 1) === rowIdx);
                }
                if (target) await target.delete();
            }
            invalidateCache();
```

- [ ] **Step 7: update-shift server preferuje Id** — v `update-shift` rozšiř destrukturalizaci o `id` (`:2069`) a úpravu hledání cíle (`:2078-2083`):

```js
    const { originalName, originalDate, originalStart, name, date, start, end, product, trading, note, id } = req.body;
```
```js
            let target = null;
            if (id) target = rows.find(r => (r.get('Id') || '') === id);
            if (!target) target = rows.find(r => {
                const rDate = convertCzechDate(r.get('Date') || '');
                return r.get('Name') === originalName && rDate === originalDate && r.get('Start') === originalStart;
            });
```
(Klient update-shift pošle `id` analogicky — pokud editační fetch existuje, přidej `id: _currentShiftSource.id` do jeho body; pokud editaci řeší jiná funkce, doplň tam stejně.)

- [ ] **Step 8: Manuální ověření**

```bash
taskkill //F //IM node.exe
node index.js
```
1. Přidej novou směnu přes UI → v Sheetu `ManualShifts` má řádek vyplněný sloupec `Id` (UUID).
2. Přidej druhou směnu. Smaž první. Ověř, že se smazala **právě ta první** a druhá zůstala správně (žádný posun).
3. Edituj směnu → změny se uloží.

- [ ] **Step 9: Verifikace JS + Commit**

```bash
git add index.js
git commit -m "feat(shifts): stable UUID Id on ManualShifts, match delete/update by Id"
```

---

## Task 8: Backfill skript pro existující směny

**Files:**
- Create: `scripts/backfill-shift-ids.js`

- [ ] **Step 1: Implementuj skript**

```js
// Jednorázové, idempotentní doplnění sloupce Id (UUID) do ManualShifts.
// Spuštění: node scripts/backfill-shift-ids.js
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

let googleKeys;
if (process.env.GOOGLE_CREDENTIALS) googleKeys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
else googleKeys = require('../credentials.json');

const auth = new JWT({
    email: googleKeys.client_email,
    key: googleKeys.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet('17iOEaSnL0ZxKYXCFiIuJkWoSbnB3INx1Ust0fBnLVg4', auth);

(async () => {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['ManualShifts'];
    if (!sheet) { console.log('ManualShifts neexistuje — nic k doplnění.'); return; }

    // Zajisti hlavičku Id
    await sheet.loadHeaderRow();
    if (!sheet.headerValues.includes('Id')) {
        await sheet.setHeaderRow([...sheet.headerValues, 'Id']);
        console.log('Přidán sloupec Id do hlavičky.');
    }

    const rows = await sheet.getRows();
    console.log('Řádků celkem: ' + rows.length);
    let filled = 0;
    for (const r of rows) {
        if (!r.get('Id')) { r.set('Id', crypto.randomUUID()); await r.save(); filled++; }
    }
    console.log('Doplněno Id: ' + filled);
    console.log('Bez Id po doběhnutí: ' + (await sheet.getRows()).filter(r => !r.get('Id')).length);
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
```

- [ ] **Step 2: Spusť (ostrý sheet) a ověř počty**

Run: `node scripts/backfill-shift-ids.js`
Expected: vypíše „Řádků celkem: N", „Doplněno Id: N" (při prvním běhu), „Bez Id po doběhnutí: 0".

- [ ] **Step 3: Ověř idempotenci** — spusť znovu

Run: `node scripts/backfill-shift-ids.js`
Expected: „Doplněno Id: 0", „Bez Id po doběhnutí: 0".

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-shift-ids.js
git commit -m "chore(shifts): one-time idempotent backfill of ManualShifts Id"
```

---

## Task 9: Sloučit duplicitní productMapping

**Files:**
- Modify: `index.js:1524-1538` (lokální kopie v CSV exportu)

- [ ] **Step 1: Ulož referenční CSV výstup před změnou** — přihlas se jako Admin a stáhni `/export-csv`, ulož jako `outputs/csv-before.csv` (gitignored).

- [ ] **Step 2: Odstraň lokální kopii** — smaž celé `const productMapping = [ ... ];` na `:1524-1538`. Funkce bude používat module-level `productMapping` (`:489-503`).

> Ověř, že uvnitř `/export-csv` se `productMapping` nepřepisuje jinde a že module-level konstanta je v scope (je — je na module úrovni). Žádné jiné změny.

- [ ] **Step 3: Porovnej CSV po změně**

```bash
taskkill //F //IM node.exe
node index.js
# stáhni /export-csv jako outputs/csv-after.csv
diff outputs/csv-before.csv outputs/csv-after.csv
```
Expected: žádný rozdíl (`diff` nic nevypíše).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "refactor(products): single source of productMapping (dedup CSV copy)"
```

---

## Task 10: Audit log prohlížečka `/admin/audit-log`

**Files:**
- Modify: `index.js` (nová routa; odkaz v dashboardu)

- [ ] **Step 1: Přidej routu** — vlož poblíž ostatních admin rout (např. za `/api/shift-history` na `:1640`):

```js
// Admin: prohlížečka audit logu
app.get('/admin/audit-log', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).send('Admin only');
    const qPerson = (req.query.person || '').toLowerCase().trim();
    const qAction = (req.query.action || '').trim();         // prefix typu akce, např. ADD_SHIFT
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
        // filtr datum
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
            + '<h2>Audit log <span style="font-size:0.8rem;color:#888;">(' + total + ' záznamů, posledních ' + days + ' dní)</span></h2>'
            + '<p><a href="/dashboard">← zpět na dashboard</a></p>'
            + '<form method="GET" action="/admin/audit-log">'
            + 'Osoba: <input name="person" value="' + esc(qPerson) + '" placeholder="jméno">'
            + 'Akce: <input name="action" value="' + esc(qAction) + '" placeholder="ADD_SHIFT, LOGIN...">'
            + 'Dní zpět: <input name="days" type="number" value="' + days + '" style="width:80px">'
            + '<button type="submit">Filtrovat</button></form>'
            + '<table><thead><tr><th>Čas</th><th>Kdo</th><th>Akce</th><th>Detail</th></tr></thead><tbody>'
            + rowsHtml + '</tbody></table>'
            + '<p style="margin-top:12px;">Stránka ' + page + '/' + pages + ' '
            + (page > 1 ? '<a href="?person=' + encodeURIComponent(qPerson) + '&action=' + encodeURIComponent(qAction) + '&days=' + days + '&page=' + (page-1) + '">← novější</a> ' : '')
            + (page < pages ? '<a href="?person=' + encodeURIComponent(qPerson) + '&action=' + encodeURIComponent(qAction) + '&days=' + days + '&page=' + (page+1) + '">starší →</a>' : '')
            + '</p></body></html>');
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});
```

> Pozn.: routa renderuje vlastní samostatnou HTML stránku (mimo velký dashboard template literal), takže nehrozí jeho rozbití. Hodnoty escapovány přes `esc()`.

- [ ] **Step 2: Přidej admin odkaz do dashboardu** — najdi admin-gated blok tlačítek (`:3883-3887`, `${req.user && req.user.role === 'Admin' ? ... : ''}`) a do něj přidej odkaz:

```html
<a href="/admin/audit-log" class="btn" style="text-decoration:none;">📋 Audit log</a>
```
(použij styl/markup konzistentní s okolními admin tlačítky)

- [ ] **Step 3: Manuální ověření**

```bash
taskkill //F //IM node.exe
node index.js
```
1. Jako Admin otevři `/admin/audit-log` → tabulka Čas/Kdo/Akce/Detail, default 90 dní.
2. Vyzkoušej filtry (osoba, akce=`LOGIN`, dní zpět).
3. Odhlas se / přihlas jako ne-admin a otevři `/admin/audit-log` → `403 Admin only`.

- [ ] **Step 4: Verifikace JS (dashboard) + Commit**

```bash
git add index.js
git commit -m "feat(audit): admin-only audit-log viewer with filters + pagination"
```

---

## Verifikace klientského JS (po každé změně template literalu)

Po Task 4, 7, 10 (mění dashboard template) ověř, že klientský JS je platný — jinak se „kalendář ztratí" bez chyby (CLAUDE.md):

1. Spusť server, otevři dashboard v prohlížeči.
2. Otevři DevTools → Console. **Žádné** červené syntax chyby.
3. Sidebar řádky se zobrazí (ne prázdná stránka).

Alternativa bez prohlížeče: stáhni rendered HTML, vyextrahuj `<script>` obsah a spusť `node -c soubor.js` (musí projít).

---

## Self-Review (proběhlo při psaní)

- **Pokrytí specu:** 1A→T1+T2, 1B→T3+T4, 1C→T7+T8, 1D→T9, 1E→T5+T6, 1F→T10. Vše pokryto.
- **Placeholdery:** žádné TBD; veškerý kód je konkrétní.
- **Konzistence typů:** `hashPassword`/`verifyPassword` (T1) použity v T2; `validateNoTemplateChars` (T5) v T6; `_currentShiftSource.id` (T7 step 4) použito v T7 step 5; sloupec `Id` konzistentní napříč add/load/delete/update/backfill.
- **Otevřený bod:** T7 step 7 — pokud editační fetch na klientovi existuje samostatně, doplnit do jeho body `id` (uvedeno přímo v kroku).
