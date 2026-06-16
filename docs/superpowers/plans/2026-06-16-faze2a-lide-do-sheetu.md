# Fáze 2A — Lidé do Sheetu: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Přesunout seznam lidí (jméno, skupina, barva) z natvrdo zadaných konstant v `index.js` do nového Google Sheetu `People`, načítat ho za běhu s bezpečným fallbackem na zabudovaný seed, a odvozovat `Lima` příznak ze skupiny.

**Architecture:** Čistá testovatelná transformace `lib/people.js` (`buildPeopleStructures`) převede řádky listu na `{peopleHierarchy, personColors, limaSet}`. V `index.js` se z `const` stanou modulové `let` proměnné, inicializované seedem (dnešní data jako fallback) a přepsané daty z listu při startu + periodicky. Migrační skript naplní list ze seedu. Žádné admin UI (to je Fáze 3).

**Tech Stack:** Node.js, Express, google-spreadsheet, vestavěný `assert` (projekt nemá test framework — testy jsou `node` skripty).

---

## Poznámka k testování

Stejně jako ve Fázi 1: pravé unit testy jen pro čistou funkci (`lib/people.js`); změny v `index.js` se ověřují `node -c` + runtime smoke testem (boot). Migrační skript se v rámci implementace **nespouští** (mění ostrý Sheet) — pustí se při QA. Na Windows před restartem serveru: `taskkill //F //IM node.exe`.

Spec: [docs/superpowers/specs/2026-06-16-faze2a-lide-do-sheetu-design.md](../specs/2026-06-16-faze2a-lide-do-sheetu-design.md)

---

## File Structure

| Soubor | Odpovědnost | Akce |
|--------|-------------|------|
| `lib/people.js` | `buildPeopleStructures(rows, groups)` — čistá transformace | Create |
| `scripts/test-people.js` | unit testy | Create |
| `scripts/migrate-people-to-sheet.js` | jednorázová migrace seed → list People | Create |
| `index.js` | seed→`let` proměnné, `buildPeopleStructures`, `refreshPeopleFromSheet`, startup load, `limaSet` místo `LIMA_MEMBERS`, export seedu | Modify |

---

## Task 1: `lib/people.js` — čistá transformace + testy

**Files:** Create `lib/people.js`, Create `scripts/test-people.js`

- [ ] **Step 1: Napiš padající test** — `scripts/test-people.js`

```js
const assert = require('assert');
const { buildPeopleStructures } = require('../lib/people');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

const GROUPS = [
  { label: 'Team Leaders',   color: '#4caf50', target: 20 },
  { label: 'Traders - Lima', color: '#ff5722', target: 40 }
];
const rows = [
  { Name: 'Alice', Group: 'Team Leaders',   Color: '#111111' },
  { Name: 'Bob',   Group: 'Traders - Lima', Color: '' },
  { Name: 'Carol', Group: 'Traders - Lima', Color: '#222222' },
  { Name: 'Ghost', Group: 'Neexistuje',     Color: '#333333' }
];
const { peopleHierarchy, personColors, limaSet, warnings } = buildPeopleStructures(rows, GROUPS);

assert.deepStrictEqual(peopleHierarchy.map(g => g.label), ['Team Leaders', 'Traders - Lima']);
ok('skupiny v poradi GROUPS');

assert.deepStrictEqual(peopleHierarchy[0].members, ['Alice']);
assert.deepStrictEqual(peopleHierarchy[1].members, ['Bob', 'Carol']);
ok('clenove ve spravnych skupinach, v poradi radku');

assert.strictEqual(peopleHierarchy[1].color, '#ff5722');
assert.strictEqual(peopleHierarchy[1].target, 40);
ok('skupina nese color+target z GROUPS');

assert.strictEqual(personColors['Alice'], '#111111');
assert.strictEqual(personColors['Bob'], '#888');
ok('personColors + fallback #888 pro prazdnou barvu');

assert.ok(limaSet.has('Bob') && limaSet.has('Carol'));
assert.ok(!limaSet.has('Alice'));
ok('limaSet jen Lima skupina');

assert.ok(!personColors['Ghost']);
assert.strictEqual(peopleHierarchy.flatMap(g => g.members).includes('Ghost'), false);
assert.ok(warnings.some(w => w.includes('Ghost')));
ok('neznama skupina vynechana + warning');

console.log('\nVSECHNY TESTY OK (' + n + ')');
```

- [ ] **Step 2: Spusť test, ověř že padá**

Run: `node scripts/test-people.js`
Expected: FAIL — `Cannot find module '../lib/people'`

- [ ] **Step 3: Implementuj `lib/people.js`**

```js
// Čistá transformace: řádky listu People + definice skupin -> datové struktury.
// Lima se odvozuje z členství ve skupině limaLabel.
function buildPeopleStructures(rows, groups, limaLabel = 'Traders - Lima') {
    const validGroups = new Set(groups.map(g => g.label));
    const membersByGroup = {};
    const personColors = {};
    const limaSet = new Set();
    const warnings = [];

    for (const r of (rows || [])) {
        const name = (r.Name || '').toString().trim();
        const group = (r.Group || '').toString().trim();
        const color = (r.Color || '').toString().trim();
        if (!name) continue;
        if (!validGroups.has(group)) {
            warnings.push('Neznama skupina "' + group + '" u osoby "' + name + '" - vynechana');
            continue;
        }
        if (!membersByGroup[group]) membersByGroup[group] = [];
        membersByGroup[group].push(name);
        personColors[name] = color || '#888';
        if (group === limaLabel) limaSet.add(name);
    }

    const peopleHierarchy = groups.map(g => ({
        label:   g.label,
        color:   g.color,
        target:  g.target,
        members: membersByGroup[g.label] || []
    }));

    return { peopleHierarchy, personColors, limaSet, warnings };
}

module.exports = { buildPeopleStructures };
```

- [ ] **Step 4: Spusť test, ověř že prochází**

Run: `node scripts/test-people.js`
Expected: PASS — `VSECHNY TESTY OK (6)`

- [ ] **Step 5: Commit**

```bash
git add lib/people.js scripts/test-people.js
git commit -m "feat(people): pure buildPeopleStructures transform + tests"
```

---

## Task 2: Přepoj `index.js` na seed-driven struktury (behavior-preserving)

Tento task **nemění chování** — appka pořád běží na seedu (dnešní data), jen je teď servíruje přes `let` proměnné a `buildPeopleStructures`. List `People` se přidá v Tasku 3.

**Files:** Modify `index.js`

- [ ] **Step 1: Přidej import** za řádek `const { validateNoTemplateChars } = require('./lib/validate');`

```js
const { buildPeopleStructures } = require('./lib/people');
```

- [ ] **Step 2: Odstraň konstantu `LIMA_MEMBERS`** — smaž celý řádek (kolem `:221`):

```js
const LIMA_MEMBERS = new Set(["Adrian M.","Andres","Christian C.","David Z.","Flabio T.","Francesco","Franco M.","Gustavo P.","Hadi B.","James H.","Jose C.","Martin M. M.","Santiago B.","William M."]);
```
Nahraď ho komentářem:
```js
// LIMA: odvozeno ze skupiny "Traders - Lima" (viz limaSet nize)
```

- [ ] **Step 3: Přejmenuj `personColors` seed** — najdi (kolem `:423`) `const personColors = {` a změň pouze tento řádek na:

```js
const SEED_PERSON_COLORS = {
```
(zbytek objektu a uzavírací `};` nech beze změny)

- [ ] **Step 4: Přejmenuj `peopleHierarchy` seed + přidej GROUPS/PEOPLE_SEED a live proměnné** — najdi `const peopleHierarchy = [` (kolem `:501`) a změň pouze tento řádek na:

```js
const SEED_HIERARCHY = [
```
Pak najdi uzavírací řádek tohoto pole (kolem `:509`):
```js
];
```
(je to `];` hned za řádkem skupiny `Traders - Lima`) a IHNED ZA NĚJ vlož:

```js

// --- Lidé: live struktury (seed = fallback; pri startu/refreshe prepsane z listu "People") ---
const GROUPS = SEED_HIERARCHY.map(({ label, color, target }) => ({ label, color, target }));
const PEOPLE_SEED = SEED_HIERARCHY.flatMap(g =>
    g.members.map(name => ({ Name: name, Group: g.label, Color: SEED_PERSON_COLORS[name] || '#888' }))
);
let peopleHierarchy, personColors, limaSet;
({ peopleHierarchy, personColors, limaSet } = buildPeopleStructures(PEOPLE_SEED, GROUPS));
```

- [ ] **Step 5: Nahraď použití `LIMA_MEMBERS.has` za `limaSet.has`** — pomocí Edit s replace_all nahraď `LIMA_MEMBERS.has(` za `limaSet.has(`. Mají být 3 výskyty (kolem `:231`, `:2098`, `:2200`). Po náhradě ověř grepem, že `LIMA_MEMBERS` se v souboru už nevyskytuje.

- [ ] **Step 6: Ověř, že nic na module-level nepoužívá `peopleHierarchy`/`personColors`/`limaSet` před přiřazením seedu**

Run: `grep -n "peopleHierarchy\|personColors\|limaSet" index.js | head -40`
Zkontroluj, že všechny výskyty (kromě seed bloku z kroku 4 a definice `SEED_*`) jsou uvnitř funkcí/route handlerů (běží až za běhu), ne na module-level mezi řádky ~423 a ~511. Pokud najdeš module-level použití dříve, NAHLAŠ to (BLOCKED) místo hádání.

- [ ] **Step 7: Syntax check**

Run: `node -c index.js`
Expected: no output (OK). Pokud chyba (např. TDZ / nedefinovaná proměnná), zkontroluj pořadí definic.

- [ ] **Step 8: Boot smoke test** (běží na seedu, list zatím neexistuje)

```bash
taskkill //F //IM node.exe 2>/dev/null
node index.js   # spusť na pozadi
```
Po pár sekundách v jiném terminálu:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/dashboard   # expect 302
taskkill //F //IM node.exe
```
Expected: server naběhne ("Drachir.gg active"), 200 a 302. (Pozn.: pokud nelze server spustit kvůli prostředí, alespoň `node -c` musí projít; runtime ověří člověk při QA.)

- [ ] **Step 9: Commit**

```bash
git add index.js
git commit -m "refactor(people): seed-driven peopleHierarchy/personColors/limaSet via buildPeopleStructures"
```

---

## Task 3: `refreshPeopleFromSheet` + načtení při startu

**Files:** Modify `index.js`

- [ ] **Step 1: Přidej loader** — vlož HNED ZA seed blok z Tasku 2 (za řádek `({ peopleHierarchy, personColors, limaSet } = buildPeopleStructures(PEOPLE_SEED, GROUPS));`):

```js

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
```

- [ ] **Step 2: Zavolej loader při startu + periodicky** — najdi v `app.listen` callbacku řádek:

```js
        console.log('Drachir.gg active');
```
Vlož IHNED ZA NĚJ:
```js
        refreshPeopleFromSheet().catch(e => console.error('[PEOPLE] Startup load failed, using seed:', e.message));
        setInterval(() => { refreshPeopleFromSheet().catch(() => {}); }, 5 * 60 * 1000);
```

- [ ] **Step 3: Zpřístupni seed/structures pro migrační skript** — najdi `module.exports = {` (kolem `:6222`) a hned za otevírací řádek přidej:

```js
    peopleHierarchy,
    personColors,
```
(přidáváme je do existujícího exportu; migrační skript je použije jako zdroj seedu)

- [ ] **Step 4: Syntax check**

Run: `node -c index.js`
Expected: no output.

- [ ] **Step 5: Boot smoke test** (list zatím neexistuje → očekáváme fallback warning)

```bash
taskkill //F //IM node.exe 2>/dev/null
node index.js   # na pozadi
```
Ověř v logu serveru řádek `[PEOPLE] List "People" nenalezen - pouzivam seed.` a že server běží (curl `/` → 200). Pak `taskkill //F //IM node.exe`.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(people): load People sheet at startup + periodic refresh (seed fallback)"
```

---

## Task 4: Migrační skript `scripts/migrate-people-to-sheet.js` (vytvořit, NEspouštět)

**Files:** Create `scripts/migrate-people-to-sheet.js`

IMPORTANT: Skript mění ostrý Google Sheet. V rámci implementace ho **NESPOUŠTĚJ** (žádné `node scripts/migrate-people-to-sheet.js`). Spustí ho člověk při QA. Pouze ho vytvoř, ověř `node -c` a commitni.

- [ ] **Step 1: Vytvoř skript** s tímto obsahem:

```js
// Jednorazova migrace: naplni list "People" (Name, Group, Color) ze zabudovaneho seedu.
// Idempotentni: pokud list uz ma radky, nic neprepisuje.
// Spusteni: node scripts/migrate-people-to-sheet.js
const { doc, peopleHierarchy, personColors } = require('../index.js');

(async () => {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['People'];
    if (!sheet) {
        sheet = await doc.addSheet({ title: 'People', headerValues: ['Name', 'Group', 'Color'] });
        console.log('Vytvoren list People.');
    } else {
        const existing = await sheet.getRows();
        if (existing.length > 0) {
            console.log('List People uz ma ' + existing.length + ' radku - migrace preskocena (idempotence).');
            return;
        }
    }
    const rows = [];
    for (const g of peopleHierarchy) {
        for (const name of g.members) {
            rows.push({ Name: name, Group: g.label, Color: personColors[name] || '#888' });
        }
    }
    await sheet.addRows(rows);
    const byGroup = {};
    rows.forEach(r => { byGroup[r.Group] = (byGroup[r.Group] || 0) + 1; });
    console.log('Zapsano ' + rows.length + ' lidi.');
    console.log('Podle skupin: ' + JSON.stringify(byGroup));
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
```

- [ ] **Step 2: Syntax check (NEspouštět tělo)**

Run: `node -c scripts/migrate-people-to-sheet.js`
Expected: no output. NESPOUŠTĚJ skript bez `-c`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-people-to-sheet.js
git commit -m "chore(people): one-time idempotent migration script seed -> People sheet"
```

---

## Verifikace JS po změnách `index.js`

Po Taskách 2 a 3 ověř `node -c index.js` a boot serveru (žádné červené chyby v konzoli, dashboard se načte). Plné vizuální ověření (seznam lidí, barvy, Lima) proběhne v lidské QA po spuštění migrace.

---

## Self-Review (proběhlo při psaní)

- **Pokrytí specu:** §4.1 list People → Task 4 (migrace) + Task 3 (čtení); §4.2 let+startup → Task 2+3; §4.3 buildPeopleStructures → Task 1; §4.4 migrace → Task 4; §4.5 úpravy index.js → Task 2+3. Vše pokryto.
- **Placeholdery:** žádné; veškerý kód konkrétní.
- **Konzistence typů:** `buildPeopleStructures(rows, groups)` → `{peopleHierarchy, personColors, limaSet, warnings}` konzistentně v Task 1/2/3; `GROUPS`/`PEOPLE_SEED`/`SEED_HIERARCHY`/`SEED_PERSON_COLORS` konzistentní; `refreshPeopleFromSheet` definovaná v Task 3 a volaná tamtéž; export `peopleHierarchy`/`personColors` (Task 3) použit migračním skriptem (Task 4).
- **Pořadí/ordering:** seed přiřazení (Task 2) je až za definicí `SEED_HIERARCHY`/`SEED_PERSON_COLORS`/`GROUPS`/`PEOPLE_SEED`; Task 2 step 6 explicitně ověřuje, že žádný module-level konzument neběží dřív.
