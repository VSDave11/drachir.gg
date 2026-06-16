# Fáze 3 — Webová správa lidí (admin): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin může na dashboardu přidat / upravit / odebrat člověka (jméno, skupina, barva, eligibilita produktů) — zápis do listů `People` a `Capabilities`, bez ručního sahání do Google Sheetu.

**Architecture:** Čistá testovatelná validační logika v `lib/people-admin.js`. V `index.js` pomocné funkce pro zápis do Sheetu (seed-safe), 4 admin-only endpointy a samostatný self-styled modal v dashboard šabloně. Po každém zápisu `refreshPeopleFromSheet()` + invalidace cache eligibility.

**Tech Stack:** Node.js, Express, google-spreadsheet, vestavěný `assert`.

---

## Poznámka k testování

Pravé unit testy jen pro čistou logiku (`lib/people-admin.js`). Endpointy/zápisy do Sheetu se ověřují `node -c` + admin-403 `curl` smoke + lidská QA (vše ostatní potřebuje admin login + ostrý Sheet). Klientský JS uvnitř šablony NESMÍ obsahovat backtick ani `${` (kromě záměrných server interpolací u serializace). Na Windows před restartem: `taskkill //F //IM node.exe`.

Spec: [docs/superpowers/specs/2026-06-16-faze3-sprava-lidi-web-design.md](../specs/2026-06-16-faze3-sprava-lidi-web-design.md)

---

## File Structure

| Soubor | Odpovědnost | Akce |
|--------|-------------|------|
| `lib/people-admin.js` | `validatePersonInput`, `computeCapabilityCells` (čisté) | Create |
| `scripts/test-people-admin.js` | unit testy | Create |
| `index.js` | helpers (`ensurePeopleSheetSeeded`, `writeCapabilityRow`, `removeCapabilityRow`), 4 endpointy, admin tlačítko + modal + klient JS | Modify |

Existující fakta (Fáze 2A): `peopleHierarchy`/`personColors`/`limaSet` jsou live `let` proměnné; `GROUPS` = 7 definic; `refreshPeopleFromSheet()` načítá list `People` (Name, Group, Color). `Capabilities`: poziční matice (ř.0 hlavička produktů od sloupce 1, sloupec 0 = jméno, buňky `1/true/x`); `loadCapabilities()` + `_capsCache`/`_capsCacheTime`. `productMapping` = 13 produktů.

---

## Task 1: `lib/people-admin.js` — čistá logika + testy

**Files:** Create `lib/people-admin.js`, Create `scripts/test-people-admin.js`

- [ ] **Step 1: Napiš padající test** — `scripts/test-people-admin.js`

```js
const assert = require('assert');
const { validatePersonInput, computeCapabilityCells } = require('../lib/people-admin');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };
const GROUPS = ['Team Leaders', 'Traders - Lima'];

// validatePersonInput
assert.strictEqual(validatePersonInput({ name: 'Nový', group: 'Team Leaders', color: '#111' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'add' }), null);
ok('platny add => null');
assert.match(validatePersonInput({ name: '', group: 'Team Leaders' }, { groups: GROUPS, existingNames: [], mode: 'add' }), /povinn/);
ok('prazdne jmeno => chyba');
assert.match(validatePersonInput({ name: 'X', group: 'Neznama' }, { groups: GROUPS, existingNames: [], mode: 'add' }), /skupina/);
ok('neznama skupina => chyba');
assert.match(validatePersonInput({ name: 'Starý', group: 'Team Leaders' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'add' }), /už existuje/);
ok('duplicita v add => chyba');
assert.strictEqual(validatePersonInput({ name: 'Starý', group: 'Team Leaders' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'update' }), null);
ok('update existujiciho => null');
assert.match(validatePersonInput({ name: 'Duch', group: 'Team Leaders' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'update' }), /neexistuje/);
ok('update neexistujiciho => chyba');

// computeCapabilityCells
const header = [{ col: 1, name: 'CS 2 Duels' }, { col: 2, name: 'Madden' }, { col: 3, name: 'eHockey' }];
const cells = computeCapabilityCells(header, ['Madden', 'eHockey']);
assert.deepStrictEqual(cells, [{ col: 1, value: '' }, { col: 2, value: 'x' }, { col: 3, value: 'x' }]);
ok('computeCapabilityCells: x pro vybrane, prazdno pro ostatni');

console.log('\nVSECHNY TESTY OK (' + n + ')');
```

- [ ] **Step 2: Spusť, ověř FAIL** — `node scripts/test-people-admin.js` → `Cannot find module '../lib/people-admin'`

- [ ] **Step 3: Implementuj `lib/people-admin.js`**

```js
// Čistá validační + výpočetní logika pro admin správu lidí (bez I/O).

function validatePersonInput(person, opts) {
    const name = (person && person.name || '').toString().trim();
    const group = (person && person.group || '').toString().trim();
    const groups = (opts && opts.groups) || [];
    const existingNames = (opts && opts.existingNames) || [];
    const mode = (opts && opts.mode) || 'add';
    if (!name) return 'Jméno je povinné';
    if (!groups.includes(group)) return 'Neznámá skupina: ' + group;
    if (mode === 'add' && existingNames.includes(name)) return 'Člověk "' + name + '" už existuje';
    if (mode === 'update' && !existingNames.includes(name)) return 'Člověk "' + name + '" neexistuje';
    return null;
}

// headerProducts: [{col, name}]; selectedProducts: [name]
// vrátí [{col, value}] kde value='x' pro vybrané, '' pro ostatní.
function computeCapabilityCells(headerProducts, selectedProducts) {
    const sel = new Set(selectedProducts || []);
    return (headerProducts || []).map(h => ({ col: h.col, value: sel.has(h.name) ? 'x' : '' }));
}

module.exports = { validatePersonInput, computeCapabilityCells };
```

- [ ] **Step 4: Spusť, ověř PASS** — `node scripts/test-people-admin.js` → `VSECHNY TESTY OK (7)`

- [ ] **Step 5: Commit**

```bash
git add lib/people-admin.js scripts/test-people-admin.js
git commit -m "feat(people-admin): pure validation + capability-cell helpers + tests"
```

---

## Task 2: Server helpers v `index.js`

**Files:** Modify `index.js`

- [ ] **Step 1: Import** — za `const { buildPeopleStructures } = require('./lib/people');` přidej:

```js
const { validatePersonInput, computeCapabilityCells } = require('./lib/people-admin');
```

- [ ] **Step 2: Přidej helpery** — vlož HNED ZA funkci `loadCapabilities()` (najdi její uzavírací `}` následované řádkem `// ========================================================================` kolem `:805`; vlož PŘED ten komentář):

```js

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

    // Mapa produkt -> sloupec z hlavicky; doplnit chybejici produkty jako nove sloupce
    const headerProducts = [];
    let lastCol = 0;
    for (let c = 1; c < 26; c++) {
        const hn = (sheet.getCell(0, c).value || sheet.getCell(0, c).formattedValue || '').toString().trim();
        if (!hn) { lastCol = c - 1; break; }
        headerProducts.push({ col: c, name: hn }); lastCol = c;
    }
    (selectedProducts || []).forEach(p => {
        if (!headerProducts.some(h => h.name === p)) { lastCol += 1; sheet.getCell(0, lastCol).value = p; headerProducts.push({ col: lastCol, name: p }); }
    });

    // Najdi radek osoby (presna shoda), jinak prvni prazdny
    let targetRow = -1, firstEmpty = -1;
    for (let r = 1; r < 200; r++) {
        const nm = (sheet.getCell(r, 0).value || '').toString().trim();
        if (nm === name) { targetRow = r; break; }
        if (!nm && firstEmpty === -1) firstEmpty = r;
    }
    if (targetRow === -1) targetRow = (firstEmpty === -1 ? 1 : firstEmpty);

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
```

- [ ] **Step 3: Syntax check + commit**

```bash
node -c index.js
git add index.js
git commit -m "feat(people-admin): sheet helpers (seed-safe People + Capabilities write/remove)"
```

---

## Task 3: Admin endpointy v `index.js`

**Files:** Modify `index.js`

- [ ] **Step 1: Přidej 4 routy** — vlož PŘED řádek `// BambooHR manual sync trigger (admin-only)` (těsně před `app.post('/api/bamboo-sync'...`, kolem `:2043`):

```js
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
    const vErr = validateNoTemplateChars(name, group, color);
    if (vErr) return res.status(400).json({ error: vErr });
    const existingNames = peopleHierarchy.flatMap(g => g.members);
    const err = validatePersonInput({ name, group, color }, { groups: GROUPS.map(g => g.label), existingNames, mode: 'add' });
    if (err) return res.status(400).json({ error: err });
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
    const vErr = validateNoTemplateChars(name, group, color);
    if (vErr) return res.status(400).json({ error: vErr });
    const existingNames = peopleHierarchy.flatMap(g => g.members);
    const err = validatePersonInput({ name, group, color }, { groups: GROUPS.map(g => g.label), existingNames, mode: 'update' });
    if (err) return res.status(400).json({ error: err });
    try {
        const sheet = await ensurePeopleSheetSeeded();
        const rows = await sheet.getRows();
        const target = rows.find(r => (r.get('Name') || '').toString().trim() === name.trim());
        if (!target) return res.status(404).json({ error: 'Nenalezen' });
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
```

- [ ] **Step 2: Syntax check** — `node -c index.js`

- [ ] **Step 3: Admin-gating smoke (curl)** — spusť server, pak:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/admin/people   # expect 403 (bez session)
curl -s -i -X POST http://localhost:3000/api/admin/people -H "Content-Type: application/json" -d "{}"   # expect 403 CSRF nebo Admin only
```
Expected: 403 (admin gating + CSRF drží). Plný happy-path test = lidská QA s admin loginem.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(people-admin): admin-only add/edit/remove/list people endpoints"
```

---

## Task 4: UI — admin tlačítko + modal + klientský JS

**Files:** Modify `index.js`

Modal je self-styled (inline styly), nezávislý na existujícím CSS. Klientský JS je v samostatném `<script>` před `</body>` dashboardu. POZOR: žádné backticky ani `${` v JS (kromě dvou záměrných `${JSON.stringify(...)}` server interpolací).

- [ ] **Step 1: Admin tlačítko** — najdi v admin bloku konec audit-log odkazu (řádek končící `&#128203; AUDIT LOG</a>`, kolem `:4024`) a IHNED ZA NĚJ vlož:

```html
        <button onclick="openPeopleAdmin()" style="display:block;box-sizing:border-box;text-align:center;background:rgba(126,87,194,0.1);color:#b39ddb;border:1px solid rgba(126,87,194,0.35);padding:9px;width:100%;cursor:pointer;font-weight:bold;margin-bottom:6px;border-radius:6px;font-size:0.75rem;transition:0.15s;" onmouseover="this.style.background='rgba(126,87,194,0.2)'" onmouseout="this.style.background='rgba(126,87,194,0.1)'">&#128101; SPRÁVA LIDÍ</button>
```

- [ ] **Step 2: Modal + JS** — najdi uzavírací `</body>` dashboard šablony (kolem `:6113`; je to ten, který je krátce před `</html>` na konci velkého `res.send(\`...\`)` dashboard handleru) a IHNED PŘED NĚJ vlož modal a script:

```html
<div id="peopleAdminModal" style="display:none;position:fixed;z-index:3000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);">
  <div style="max-width:760px;margin:40px auto;background:#13141c;border:1px solid #2a2d3a;border-radius:14px;max-height:88vh;overflow:auto;padding:22px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 style="color:#b39ddb;font-size:1.1rem;margin:0;">&#128101; Správa lidí</h2>
      <button onclick="closePeopleAdmin()" style="background:none;border:none;color:#888;font-size:1.4rem;cursor:pointer;">&times;</button>
    </div>
    <div id="paFormWrap" style="background:rgba(255,255,255,0.03);border:1px solid #2a2d3a;border-radius:10px;padding:14px;margin-bottom:16px;">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <label style="font-size:0.7rem;color:#9aa;">Jméno<br><input id="paName" style="padding:7px;background:#0d0e14;color:#eee;border:1px solid #2a2d3a;border-radius:6px;width:170px;"></label>
        <label style="font-size:0.7rem;color:#9aa;">Skupina<br><select id="paGroup" style="padding:7px;background:#0d0e14;color:#eee;border:1px solid #2a2d3a;border-radius:6px;"></select></label>
        <label style="font-size:0.7rem;color:#9aa;">Barva<br><input id="paColor" type="color" value="#8888aa" style="padding:2px;background:#0d0e14;border:1px solid #2a2d3a;border-radius:6px;height:34px;width:48px;"></label>
      </div>
      <div style="font-size:0.7rem;color:#9aa;margin:12px 0 6px;">Eligibilita (produkty):</div>
      <div id="paProducts" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
      <div style="margin-top:14px;display:flex;gap:8px;">
        <button id="paSaveBtn" onclick="paSave()" style="background:#7e57c2;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;">Přidat</button>
        <button onclick="paResetForm()" style="background:#2a2d3a;color:#ccc;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Vyčistit</button>
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
  function closePeopleAdmin(){ document.getElementById('peopleAdminModal').style.display = 'none'; }
  function paResetForm(){
    _paEditing = null;
    document.getElementById('paName').value = '';
    document.getElementById('paName').readOnly = false;
    document.getElementById('paColor').value = '#8888aa';
    document.querySelectorAll('.pa-prod').forEach(function(c){ c.checked = false; });
    document.getElementById('paSaveBtn').textContent = 'Přidat';
    document.getElementById('paMsg').textContent = '';
  }
  function paSetMsg(t, okFlag){ var m = document.getElementById('paMsg'); m.textContent = t; m.style.color = okFlag ? '#69c56e' : '#ff6b6b'; }
  function paLoad(){
    fetch('/api/admin/people').then(function(r){ return r.json(); }).then(function(d){
      if (!d.people) { document.getElementById('paList').textContent = 'Chyba načtení'; return; }
      var html = '';
      d.people.forEach(function(p){
        var prods = (p.products || []).length;
        html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #1e2030;">'
          + '<span style="width:12px;height:12px;border-radius:50%;background:' + p.color + ';flex-shrink:0;"></span>'
          + '<span style="flex:1;">' + p.name + ' <span style="color:#667;">· ' + p.group + ' · ' + prods + ' prod.</span></span>'
          + '<button onclick=\'paEdit(' + JSON.stringify(p).replace(/'/g, "&#39;") + ')\' style="background:#2a2d3a;color:#bbb;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:0.72rem;">Upravit</button>'
          + '<button onclick="paRemove(' + JSON.stringify(p.name) + ')" style="background:rgba(255,68,68,0.12);color:#ff8a8a;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:0.72rem;">Odebrat</button>'
          + '</div>';
      });
      document.getElementById('paList').innerHTML = html;
    });
  }
  function paEdit(p){
    _paEditing = p.name;
    document.getElementById('paName').value = p.name;
    document.getElementById('paName').readOnly = true;
    document.getElementById('paGroup').value = p.group;
    document.getElementById('paColor').value = (/^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#8888aa');
    var set = {}; (p.products || []).forEach(function(x){ set[x] = true; });
    document.querySelectorAll('.pa-prod').forEach(function(c){ c.checked = !!set[c.value]; });
    document.getElementById('paSaveBtn').textContent = 'Uložit změny';
    paSetMsg('Úprava: ' + p.name, true);
  }
  function paSave(){
    var name = document.getElementById('paName').value.trim();
    var group = document.getElementById('paGroup').value;
    var color = document.getElementById('paColor').value;
    var products = Array.prototype.slice.call(document.querySelectorAll('.pa-prod:checked')).map(function(c){ return c.value; });
    if (!name) { paSetMsg('Zadej jméno', false); return; }
    var url = _paEditing ? '/api/admin/people/update' : '/api/admin/people';
    document.getElementById('paSaveBtn').disabled = true;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, group: group, color: color, products: products }) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        document.getElementById('paSaveBtn').disabled = false;
        if (!res.ok) { paSetMsg('Chyba: ' + (res.j.error || 'neznámá'), false); return; }
        paSetMsg('Uloženo', true); paResetForm(); paLoad();
      }).catch(function(e){ document.getElementById('paSaveBtn').disabled = false; paSetMsg('Chyba: ' + e.message, false); });
  }
  function paRemove(name){
    if (!confirm('Odebrat ' + name + '?')) return;
    fetch('/api/admin/people/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){ if (!res.ok) { paSetMsg('Chyba: ' + (res.j.error || ''), false); return; } paSetMsg('Odebráno', true); paResetForm(); paLoad(); });
  }
</script>
```

> Pozn.: `fetch` POSTy jdou přes globální CSRF wrapper z Fáze 1 (přidá `X-CSRF-Token`). `JSON.stringify(p)` v `onclick` je escapováno přes `.replace(/'/g, "&#39;")` (apostrofy). Žádný backtick ani `${` v JS bloku — jen dvě záměrné `${JSON.stringify(...)}` server interpolace u `PA_GROUPS`/`PA_PRODUCTS`.

- [ ] **Step 3: Syntax check** — `node -c index.js` (musí projít; pokud ne, hledej zanesený backtick / `${` v JS).

- [ ] **Step 4: Boot smoke + JS** — spusť server; v prohlížeči (admin) otevři dashboard, klikni „Správa lidí" → modal se otevře, načte seznam lidí; konzole bez chyb. (Plná QA = přidat/upravit/odebrat naživo.) Pak `taskkill //F //IM node.exe`.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(people-admin): admin people-management modal UI on dashboard"
```

---

## Verifikace JS po Tasku 4

`node -c index.js` + boot + otevření modalu v prohlížeči (žádné červené chyby v konzoli, sidebar se zobrazí). Pokud se „kalendář ztratí", je v JS bloku zanesený backtick/`${` — oprav.

---

## Self-Review (proběhlo při psaní)

- **Pokrytí specu:** §4.1 UI → Task 4; §4.2 endpointy → Task 3; §4.3 validace → Task 1+3; §4.4 čistá logika → Task 1; §4.5 seed-safe → Task 2 (`ensurePeopleSheetSeeded`) použito v Task 3. Capabilities zápis/mazání → Task 2. Vše pokryto.
- **Placeholdery:** žádné; veškerý kód konkrétní.
- **Konzistence typů:** `validatePersonInput(person, {groups, existingNames, mode})` a `computeCapabilityCells(headerProducts, selectedProducts)` (Task 1) volané v Task 2/3 stejně; helpery `ensurePeopleSheetSeeded`/`writeCapabilityRow`/`removeCapabilityRow` (Task 2) volané v Task 3; endpointy `/api/admin/people[/update|/remove]` konzistentní s `fetch` URL v Task 4; pole `{name,group,color,products}` konzistentní klient↔server.
- **Riziko pořadí:** helpery (Task 2) jsou definované za `loadCapabilities` (~805), endpointy (Task 3) je volají za běhu — OK. `productMapping`, `GROUPS`, `peopleHierarchy`, `personColors`, `refreshPeopleFromSheet`, `_capsCache` existují z 2A/dřív.
