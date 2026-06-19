# Fáze 2B — Produkty do Sheetu: Implementation Plan

> Spec: [`specs/2026-06-19-faze2b-produkty-do-sheetu-design.md`](../specs/2026-06-19-faze2b-produkty-do-sheetu-design.md). Schválená rozhodnutí (2026-06-19): jeden list `Products` + kategorie napevno; „Other" pseudo-produkty napevno; behavior-preserving (admin UI = Fáze 3); přibalit oba latentní bugfixy.

Vše v `C:\Projekty\drachir-gg`. Zrcadlí 2A (`lib/people.js` + seed-fallback). Čísla řádků jsou k dnešnímu `index.js` (HEAD `e7b0420`) — před editací vždy znovu ověřit kontext.

## Poznámka k testování

Bez test runneru — čisté funkce v `lib/` mají `scripts/test-*.js` spouštěné `node scripts/test-products.js` (assert, vzor `test-people.js`). Po každé změně `index.js` ověřit klientský JS (`node -c` na extrahovaném `<script>`). Regresní jistota = identický výstup před/po (seed = dnešní data, takže nesmí vzniknout žádný rozdíl).

## File Structure

```
lib/products.js                          (CREATE)  buildProductStructures
scripts/test-products.js                 (CREATE)  unit testy
scripts/migrate-products-to-sheet.js     (CREATE)  idempotentní seed listu Products (NEspouštět)
index.js                                 (MODIFY)  seed/const→let/refresh/wiring; smazat route-local tradingHierarchy + duplikát productsByTrading; 2 bugfixy
```

Žádný zápis do Sheetu se v rámci implementace nespouští (migrace pustí David ručně).

---

## Task 1: `lib/products.js` — čistá transformace + testy

Čistá funkce (bez I/O). Z řádků listu `Products` + hardcoded kategorií poskládá všechny 4 live struktury.

```js
// Čistá transformace: řádky listu Products + definice kategorií -> datové struktury produktů.
// Sloty mají offsety vždy 0/1/2 (night/morning/afternoon) - neukládají se, jen časy.
const TIME_RE = /^\d{1,2}:\d{2}$/;

function buildProductStructures(rows, categories) {
    const validCats = new Set(categories.map(c => c.name));
    const catColor = {}; categories.forEach(c => { catColor[c.name] = c.color; });
    const warnings = [];
    const parsed = [];

    for (const r of (rows || [])) {
        const name = (r.Name || '').toString().trim();
        if (!name) continue;
        if (name.includes('`') || name.includes('${')) {        // template-literal guard (CLAUDE.md)
            warnings.push('Nazev "' + name + '" obsahuje zakazany znak (`/${) - vynechan'); continue;
        }
        const trading = (r.Trading || '').toString().trim();
        if (!validCats.has(trading)) {
            warnings.push('Neznama kategorie "' + trading + '" u "' + name + '" - vynechan'); continue;
        }
        const sc = Number((r.StartCol || '').toString().trim());
        if (!Number.isInteger(sc) || sc < 0) {
            warnings.push('Nevalidni StartCol u "' + name + '" - vynechan'); continue;
        }
        const slotCols = [['NightStart','NightEnd'],['MorningStart','MorningEnd'],['AfternoonStart','AfternoonEnd']];
        let timesOk = true;
        const slots = slotCols.map(([sk, ek], i) => {
            const s = (r[sk] || '').toString().trim();
            const e = (r[ek] || '').toString().trim();
            if (!TIME_RE.test(s) || !TIME_RE.test(e)) timesOk = false;
            return { o: i, s, e };
        });
        if (!timesOk) { warnings.push('Nevalidni cas slotu u "' + name + '" - vynechan'); continue; }

        parsed.push({
            name, trading, startCol: sc, slots,
            color: (r.Color || '').toString().trim(),
            covSlots: (r.CoverageSlots || '').toString().trim(),
            covDays:  (r.CoverageDays  || '').toString().trim(),
        });
    }

    parsed.sort((a, b) => a.startCol - b.startCol);

    // Sheet-level gate: chyba sloupcové mřížky NESMÍ projít (drží se seed).
    let rejected = null;
    if (parsed.length === 0) rejected = 'zadny platny produkt';
    if (!rejected) {
        for (let i = 1; i < parsed.length; i++) {
            if (parsed[i].startCol <= parsed[i-1].startCol + 2) {   // bloky 3 sloupců se nesmí překrývat
                rejected = 'prekryvajici se StartCol: "' + parsed[i-1].name + '" a "' + parsed[i].name + '"'; break;
            }
        }
    }
    if (!rejected) {
        const maxCol = Math.max(...parsed.map(p => p.startCol + 2));
        if (maxCol >= 54) rejected = 'StartCol presahuje OFF sloupce (max col ' + maxCol + ' >= 54)';  // OFF/Vacation = 54-58
    }
    if (rejected) return { rejected, warnings, productMapping: [], productColors: {}, productCoverage: {}, tradingHierarchy: [] };

    const productMapping = parsed.map(p => ({
        name: p.name, startCol: p.startCol, trading: p.trading,
        slots: p.slots.map(s => ({ o: s.o, s: s.s, e: s.e })),
    }));

    const productColors = {};
    parsed.forEach(p => { productColors[p.name] = p.color || catColor[p.trading] || '#888'; });

    const productCoverage = {};
    parsed.forEach(p => {
        if (!p.covSlots && !p.covDays) return;       // default 0,1,2 / all -> neukládat
        const slots = p.covSlots
            ? p.covSlots.split(',').map(x => parseInt(x.trim(), 10)).filter(x => !isNaN(x))
            : [0,1,2];
        productCoverage[p.name] = { slots, days: p.covDays || 'all' };
    });

    const subsByCat = {};
    parsed.forEach(p => { (subsByCat[p.trading] = subsByCat[p.trading] || []).push(p.name); });   // už v startCol pořadí
    const tradingHierarchy = categories.map(c => ({
        name: c.name, color: c.color, icon: c.icon,
        subs: c.subs ? c.subs.slice() : (subsByCat[c.name] || []),   // "Other" = statické subs ze seedu
    }));

    return { productMapping, productColors, productCoverage, tradingHierarchy, warnings, rejected: null };
}

module.exports = { buildProductStructures };
```

**`scripts/test-products.js`** (assert, vzor `test-people.js`) — minimálně:
1. Rekonstrukce ze seedu (13 řádků) → `productMapping` identický (name/startCol/trading/slots) s dnešním literálem.
2. `productColors` = 13 barev; prázdná barva → barva kategorie.
3. `productCoverage` = jen ne-defaultní (3 overridy: Table Tennis/WoT/eHockey); ostatní chybí → `getCoverageProfile` default.
4. `tradingHierarchy`: 8 reálných kategorií se `subs` odvozenými v `startCol` pořadí (FIFA = Valhalla A,B,C,Valkyrie A,B); „Other" = statické subs; barvy/ikony ze seedu.
5. Neznámá kategorie → warning + vynecháno.
6. Nevalidní `StartCol` (text) → warning + vynecháno.
7. Nevalidní čas slotu → warning + vynecháno.
8. **Duplicitní/překrývající `startCol` → `rejected` neprázdné, struktury prázdné.**
9. `startCol` přesahující 54 → `rejected`.

---

## Task 2: Přepoj `index.js` na seed-driven struktury (behavior-preserving)

**2.1 Require** (u `lib/people` ~`index.js:8`):
```js
const { buildProductStructures } = require('./lib/products');
```

**2.2 Přejmenovat literály na seedy:**
- `index.js:488` `const productColors` → `const PRODUCT_COLORS_SEED`
- `index.js:543` `const productMapping` → `const PRODUCT_MAPPING_SEED`
- `index.js:925` `const productCoverage` → `const PRODUCT_COVERAGE_SEED`

**2.3 Přidat kategorie + seed řádky + live `let`** (hned za `PRODUCT_COVERAGE_SEED`, ~`index.js:929`):
```js
const TRADING_CATEGORIES = [
    { name: "FIFA",         color: "#fbc02d", icon: "&#9917;"   },
    { name: "NBA",          color: "#2196f3", icon: "&#127936;" },
    { name: "Cricket",      color: "#4caf50", icon: "&#127955;" },
    { name: "Duels",        color: "#9c27b0", icon: "&#9876;"   },
    { name: "eTouchdown",   color: "#795548", icon: "&#127944;" },
    { name: "Table Tennis", color: "#00bcd4", icon: "&#127955;" },
    { name: "Tanks",        color: "#607d8b", icon: "&#128299;" },
    { name: "Hockey",       color: "#e91e63", icon: "&#127954;" },
    { name: "Other",        color: "#607d8b", icon: "&#128203;",
      subs: ["Stand Up", "1on1", "All Hands", "Training", "Interview", "Other Event", "RIP", "Vacation"] }
];

// Seed = dnešní data (fallback; při startu/refreshe přepsané z listu "Products").
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
```

> `getProductMeta` (`index.js:918`) a `getCoverageProfile` (`index.js:931`) zůstávají — uzavírají nad live `let` (volají se až za běhu, ne při loadu, takže TDZ nevadí).

**2.4 Smazat route-local `tradingHierarchy`** (`index.js:3405-3415`). `getProductColor` (3417-3421) i konzumenti (timeline 3616, sidebar 4307, modal 4438, `tColors` 3951) pak čtou modulový live `tradingHierarchy`. **Nic jiného neměnit** — jména a tvar struktury jsou identické.

**2.5 Nahradit duplikát `productsByTrading`** (`index.js:5317`) odvozením z live `tradingHierarchy` (serializace do klientského JS):
```js
const productsByTrading = ${JSON.stringify(Object.fromEntries(tradingHierarchy.map(t => [t.name, t.subs])))};
```
(Pozor: `${...}` je server-side interpolace uvnitř template literalu route. Názvy jsou validované → JSON bez `` ` ``.)

**2.6 `module.exports`** (`index.js:~6750`): `productMapping`, `productCoverage` (+ `getProductMeta`, `getCoverageProfile`) už jsou `let` — export zachytí **seed** hodnoty (refresh se v `require()` kontextu nespustí, je pod `require.main === module`). To je správně: scripty (migrace, solver) chtějí kanonická seed data. Rozhraní exportů neměnit; přidat `productColors` (potřebuje migrace).

---

## Task 3: `refreshProductsFromSheet` + načtení při startu

**3.1 Loader** (za `refreshPeopleFromSheet`, ~`index.js:541`):
```js
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
        productMapping  = built.productMapping;
        productColors   = built.productColors;
        productCoverage = built.productCoverage;
        tradingHierarchy = built.tradingHierarchy;
        built.warnings.forEach(w => console.warn('[PRODUCTS] ' + w));
        console.log('[PRODUCTS] Nacteno z listu: ' + built.productMapping.length + ' produktu.');
    } catch (e) {
        console.error('[PRODUCTS] Chyba nacitani, ponechavam soucasna data:', e.message);
    }
}
```

**3.2 Wiring** v `app.listen` (hned za lidi, `index.js:6719-6720`):
```js
refreshProductsFromSheet().catch(e => console.error('[PRODUCTS] Startup load failed, using seed:', e.message));
setInterval(() => { refreshProductsFromSheet().catch(() => {}); }, 5 * 60 * 1000);
```
> Pořadí: dát **před** warm `loadAllShifts` (6722), ať případná sheet-data stihnou ovlivnit první cache. Není awaited (jako lidi) — seed init garantuje data před 1. requestem; seed == sheet, takže žádná regrese.

---

## Task 4: Migrační skript `scripts/migrate-products-to-sheet.js` (vytvořit, NEspouštět)

Idempotentní, vzor `migrate-people-to-sheet.js`:
```js
// Jednorazova migrace: naplni list "Products" ze zabudovaneho seedu (productMapping+productColors+productCoverage).
// Idempotentni: pokud list uz ma radky, nic neprepisuje.  Spusteni: node scripts/migrate-products-to-sheet.js
const { doc, productMapping, productColors, productCoverage } = require('../index.js');
const HEADERS = ['Name','Trading','Color','StartCol','NightStart','NightEnd','MorningStart','MorningEnd','AfternoonStart','AfternoonEnd','CoverageSlots','CoverageDays'];

(async () => {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['Products'];
    if (!sheet) { sheet = await doc.addSheet({ title: 'Products', headerValues: HEADERS }); console.log('Vytvoren list Products.'); }
    else {
        const existing = await sheet.getRows();
        if (existing.length > 0) { console.log('List Products uz ma ' + existing.length + ' radku - migrace preskocena (idempotence).'); return; }
    }
    const rows = productMapping.map(p => {
        const cov = productCoverage[p.name];
        return {
            Name: p.name, Trading: p.trading, Color: productColors[p.name] || '', StartCol: p.startCol,
            NightStart: p.slots[0].s, NightEnd: p.slots[0].e,
            MorningStart: p.slots[1].s, MorningEnd: p.slots[1].e,
            AfternoonStart: p.slots[2].s, AfternoonEnd: p.slots[2].e,
            CoverageSlots: cov ? cov.slots.join(',') : '', CoverageDays: cov ? cov.days : '',
        };
    });
    await sheet.addRows(rows, { raw: true }); // raw => Google neprepise "06:44"->"6:44" ani "0,1,2"->"2000,1,2"
    console.log('Zapsano ' + rows.length + ' produktu.');
    rows.forEach(r => console.log('  ' + r.Name + ' -> col ' + r.StartCol + ' / ' + r.Trading));
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
```

---

## Task 5: Bonus bugfixy (sloupcová matematika)

**5.1 `/exchange-shift` rozsah** (`index.js:2490`): `loadCells('A1:AQ500')` → `loadCells('A1:BG500')`. Sloupec AQ = 42; eHockey afternoon = `50+2 = 52` je mimo → výměna WoT/eHockey tiše selže. BG (58) pokryje produkty (≤52) i OFF (54-58), shodně s `loadAllShifts` (624) a CSV (1676). Ověřit přesný řetězec před editací.

**5.2 `scripts/commit-to-schedule.js:220`**: zápis na `pm.startCol + p.slotIndex` → `pm.startCol + slot.o` (konzistentní se zbytkem; dnes funguje jen náhodou, protože `o === slotIndex`). Před editací načíst kontext kolem řádku 220 a ověřit proměnné (`slot` vs `p.slotIndex`).

---

## Verifikace JS po změnách `index.js`

1. `node -e "require('./index.js')"` — modul se načte bez chyby (ověří seed init + `buildProductStructures`).
2. Extrahovat dashboard `<script>` z renderu a `node -c` — klientský JS validní (kvůli změně `productsByTrading` serializace).
3. `node scripts/test-products.js` — vše OK.
4. Regrese: `node scripts/test-people.js`, `node scripts/test-stats.js`, `node scripts/test-ordering.js`, `node scripts/test-bulk.js` — beze změny.
5. Manuálně `node index.js` (po `taskkill //F //IM node.exe`): dashboard se vykreslí **bez listu Products** (seed cesta) — timeline product rows, sidebar „Trading Products", barvy pilulek, Add-Shift dropdowny identické; log `[PRODUCTS] ... nenalezen - pouzivam seed.`
6. (Volitelně, s Davidem) pustit migraci → reload → diff výstupu dashboard/CSV/stats před/po (musí být identický).

## Self-Review (vyplnit při psaní)

- [ ] Seed = přesně dnešní data (13 produktů, 3 coverage overridy, 9 kategorií) → `buildProductStructures(PRODUCTS_SEED, TRADING_CATEGORIES)` dá bit-identické `productMapping`/`productColors`/`productCoverage`/`tradingHierarchy` jako dnešní literály.
- [ ] Žádný zbylý odkaz na route-local `tradingHierarchy` ani na hardcoded `productsByTrading` literál (grep).
- [ ] `getProductColor`, timeline, sidebar, modal, `tColors`, `pColorsProduct`, `_productList`, `PA_PRODUCTS` čtou live struktury a renderují identicky.
- [ ] Sheet-level gate `rejected` ošetřuje vadný/překrývající `startCol` (drží seed) — mřížka se nikdy tiše nerozbije.
- [ ] Žádný `` ` ``/`${` se z dat nedostane do template (validace v `buildProductStructures`).
- [ ] Migrační skript je idempotentní a NEspuštěný; exporty nesou seed (ne sheet) hodnoty.
- [ ] Oba bugfixy ověřené proti skutečnému řetězci/kontextu.
