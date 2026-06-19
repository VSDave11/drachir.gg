# Fáze 2B — Produkty do Sheetu (design)

**Projekt:** muj-kalendar (drachir) — směnový plánovací dashboard
**Datum:** 2026-06-19
**Stav:** návrh ke schválení
**Předchůdce:** Fáze 2A (lidé do Sheetu) — hotová, v `main`; Fáze 3 (admin správa lidí) — hotová

> Technické názvy (funkce, soubory, sloupce, struktury) jsou záměrně v angličtině, ať sedí s kódem.

---

## 1. Kontext a pozice v roadmapě

Celková roadmapa má 6 fází (viz spec Fáze 1). Fáze 2 = „přesun lidí a produktů z kódu do Sheetu" byla rozdělena:

- Fáze 2A — Lidé do Sheetu ✅ hotová (`lib/people.js` + list `People`)
- **Fáze 2B — Produkty do Sheetu** ← *tento dokument*
- (Fáze 3 — Admin UI na webu — pro lidi hotová; produktovou část dotáhne až 2B)

**Proč jsou produkty složitější než lidé:** list `People` má 3 ploché sloupce (`Name, Group, Color`). Produkt nese mnohem víc a hlavně **`startCol` — natvrdo zadrátovaný offset sloupce do mřížky listů `Schedule - <Měsíc>`**, podle kterého se směny *čtou i zapisují*. Špatný `startCol` tiše rozhodí čtení i zápis celé mřížky. Proto je 2B riziková a děláme ji s validací a checkpointy.

**Co 2B umožní dál:** po 2B jsou produkty řízené Sheetem → Fáze 3 může přidat formulář „přidat/upravit produkt" stejně, jako už umí lidi. (Samotné to UI je ne-cíl 2B, viz níže.)

---

## 2. Cíle a ne-cíle

### Cíle
1. Definice produktů (název, trading kategorie, barva, `startCol`, časy 3 slotů, coverage override) žijí v Google Sheetu, ne natvrdo v kódu.
2. Appka načítá produkty z listu při startu; když list chybí / je prázdný / je vadný, **bezpečně spadne zpět na zabudovaný seed** (nikdy nespadne, nikdy nerozbije mřížku).
3. Trading kategorie (`tradingHierarchy`) se odvozuje z jednoho zdroje pravdy — žádné tři ručně synchronizované kopie (`tradingHierarchy`, `productsByTrading`, částečně `productMapping`).
4. **Žádná regrese:** dashboard, statistiky, CSV export, AI generátor, commit do Sheetu a solver vidí identické produkty/barvy/sloty/sloupce jako dnes (ověřeno diffem).
5. Přísnější ochrana než u lidí: chyba v `startCol` nebo v časech slotu **nesmí** tiše poškodit mřížku — vadné řádky se zahodí s warningem, hrubě nekonzistentní list se odmítne celý (drží se seed).

### Ne-cíle (řeší pozdější fáze / samostatně)
- **Admin UI pro přidávání/editaci produktů na webu → Fáze 3.** 2B jen dostane data do Sheetu (behavior-preserving), neřeší formuláře ani vkládání nových sloupců do listů `Schedule`.
- Vkládání/odebírání 4-sloupcových bloků do měsíčních listů `Schedule` (to je nejrizikovější část a patří do návrhu Fáze 3, ne sem).
- Přesun „Other" pseudo-produktů (Stand Up, 1on1, All Hands, Training, Interview, Other Event, RIP, Vacation) do Sheetu — viz §4.1, zůstávají v seedu kategorií (nejsou to mřížkové produkty).
- Generalizace počtu slotů (zůstává napevno 3: night/morning/afternoon).
- Přesun definic kategorií (barva/ikona) do Sheetu — zůstávají v kódu (9 kategorií se prakticky nemění, stejně jako 7 rolí lidí v 2A).

---

## 3. Současný stav (ověřená fakta)

Vše v `C:\Projekty\drachir-gg`. Řádky ověřeny proti kódu (pozn.: `criteria.md` cituje zastaralá čísla řádků).

| Struktura | Místo | Obsah |
|-----------|-------|-------|
| `productColors` | `index.js:488-502` | 13 produktů → hex barva |
| `productMapping` | `index.js:543-557` | 13 produktů: `{name, startCol, trading, slots:[{o,s,e}×3]}` — řídí čtení **i** zápis buněk mřížky |
| `productCoverage` | `index.js:925-929` | 3 overridy (Table Tennis / World of Tanks / eHockey); ostatní default `{slots:[0,1,2], days:'all'}` |
| `getCoverageProfile(name)` | `index.js:931-933` | `productCoverage[name] || {slots:[0,1,2],days:'all'}` |
| `getProductMeta(name)` | `index.js:919` | `productMapping.find(p=>p.name===name)` |
| `tradingHierarchy` | `index.js:3405-3415` (uvnitř route `/dashboard`) | 9 kategorií (8 reálných + „Other"), každá `{name, color, icon, subs[]}` |
| `productsByTrading` (klient) | `index.js:5317` | **ruční duplikát** subs z `tradingHierarchy`, serializovaný do klientského JS |
| `getProductColor()` | `index.js:3417-3421` | `productColors[product]` → barva kategorie z `tradingHierarchy` → `#555` |

### Strukturální fakta, která migrace musí zachovat
- **Všech 13 produktů má přesně 3 sloty** s offsety `o:0,1,2` (night/morning/afternoon). Druh slotu se všude odvozuje z indexu (`slotIndex===0?'night':1?'morning':'afternoon'`).
- **`startCol` = 2, 6, 10, …, 50** (krok 4: 3 sloty + 1 mezera). Produkty zabírají sloupce 2–52. OFF/Vacation sloupce jsou napevno 54–58 (`index.js:668-669`), takže produktová mřížka nesmí přerůst sloupec 53.
- **Čtení mřížky** (`loadAllShifts`, `index.js:640-666`): pro každý produkt × slot čte buňku `startCol + slot.o`; overnight korekce data, když `startH ≥ 20 && endH < 12` (`index.js:647-652`).
- **Stejná aritmetika `startCol + slot.o`** se opakuje v: CSV exportu (`index.js:1700`), commit-write-back (`index.js:6636, 6656`), a ve scriptech (viz §6).
- **Kategorie `Trading` na směně** se nastavuje z `pm.trading` (`index.js:658`); názvy produktů se shodují napříč `productMapping.name`, `tradingHierarchy.subs` i klíči `productColors`.
- **Kategorie „Other"** (`index.js:3414`) obsahuje 8 pseudo-produktů, které **nejsou** v `productMapping` (Stand Up, 1on1, All Hands, Training, Interview, Other Event, RIP, Vacation). Musí zůstat volitelné v Add-Shift modalu a dostat řádky v timeline.
- **Vacation** směny nesou `Trading: 'HR'` (`index.js:679`) — sirotek vůči `tradingHierarchy` (žádná kategorie „HR", barva padne na `#555`). 2B na tom nic nemění.

### Vedlejší nálezy (latentní bugy, mimo hlavní scope — viz §9)
- **`/exchange-shift`** (`index.js:2490`) načítá jen `A1:AQ500` (sloupec 42) → World of Tanks (`startCol 46`) a eHockey (`startCol 50`) jsou **mimo rozsah**, výměna těch produktů tiše selže. Reálný bug už dnes.
- **`scripts/commit-to-schedule.js:220`** zapisuje na `pm.startCol + p.slotIndex` místo `+ slot.o` — funguje jen proto, že `o === slotIndex` u všech produktů.
- CLAUDE.md tvrdí, že `productMapping` je duplikovaný v CSV cestě — **už neplatí**, je jediná kopie (CSV cesta používá modulovou konstantu, `index.js:1677`).

---

## 4. Návrh

Zrcadlíme osvědčený 2A pattern: hardcoded seed = fallback, čistá transformace v `lib/`, self-healing async loader, idempotentní migrační skript.

| 2A (lidé) | 2B (produkty) |
|-----------|---------------|
| `GROUPS` hardcoded (7 rolí, label/color/target) | `TRADING_CATEGORIES` hardcoded (9 kategorií, name/color/icon/order) |
| list `People` = členství + barva | list `Products` = produkty s mřížkovými daty |
| `buildPeopleStructures(rows, groups)` | `buildProductStructures(rows, categories)` |
| `refreshPeopleFromSheet()` | `refreshProductsFromSheet()` |
| `scripts/migrate-people-to-sheet.js` | `scripts/migrate-products-to-sheet.js` |

### 4.1 List `Products` (nový Google Sheet)

Jeden řádek = jeden **reálný mřížkový produkt** (13 řádků). Sloty mají offsety vždy 0/1/2, takže offset neukládáme — ukládáme jen 3× start/end.

| Sloupec | Typ | Význam |
|---------|-----|--------|
| `Name` | string | Kanonický název produktu (přesně jako dnes) |
| `Trading` | string | Kategorie — musí být jedna z `TRADING_CATEGORIES` |
| `Color` | hex | Barva produktu (prázdné → barva kategorie) |
| `StartCol` | int | 0-based offset prvního (night) sloupce v mřížce `Schedule` |
| `NightStart` / `NightEnd` | HH:MM | Slot 0 |
| `MorningStart` / `MorningEnd` | HH:MM | Slot 1 |
| `AfternoonStart` / `AfternoonEnd` | HH:MM | Slot 2 |
| `CoverageSlots` | string | Override coverage, např. `0,1,2` nebo `1` (prázdné → default `0,1,2`) |
| `CoverageDays` | string | Override, např. `all` nebo `Mon-Fri` (prázdné → `all`) |

**Pseudo-produkty „Other"** (Vacation/RIP/Training/…) **do listu nepatří** — nemají barvu/`startCol`/sloty, nejsou mřížkové. Zůstávají jako fixní `subs` u kategorie „Other" v `TRADING_CATEGORIES` (seed). Důvod: jsou to typy událostí pro manuální zadání, prakticky se nemění — stejná logika, jako že 2A nechalo definice skupin v kódu.

### 4.2 Načítání (modulové `let` + load při startu)

Stejný tvar jako lidé (`index.js:520-541`, `6719-6720`):

```js
const TRADING_CATEGORIES = [ /* 9 kategorií: name, color, icon, (+ subs jen u "Other") */ ];
const PRODUCTS_SEED = [ /* 13 řádků odvozených z dnešního productMapping+productColors+productCoverage */ ];

let productMapping, productColors, productCoverage, tradingHierarchy;
({ productMapping, productColors, productCoverage, tradingHierarchy } =
    buildProductStructures(PRODUCTS_SEED, TRADING_CATEGORIES));

async function refreshProductsFromSheet() {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Products'];
    if (!sheet) { console.warn('[PRODUCTS] List "Products" nenalezen - pouzivam seed.'); return; }
    const rows = (await sheet.getRows()).map(r => ({ /* …12 sloupců… */ }));
    if (rows.length === 0) { console.warn('[PRODUCTS] prazdny - seed.'); return; }
    const built = buildProductStructures(rows, TRADING_CATEGORIES);
    if (built.rejected) { console.error('[PRODUCTS] List odmitnut (' + built.rejected + ') - drzim seed.'); return; }
    ({ productMapping, productColors, productCoverage, tradingHierarchy } = built);
    built.warnings.forEach(w => console.warn('[PRODUCTS] ' + w));
    console.log('[PRODUCTS] Nacteno z listu: ' + built.productMapping.length + ' produktu.');
  } catch (e) {
    console.error('[PRODUCTS] Chyba nacitani, ponechavam soucasna data:', e.message);
  }
}
```

Wiring v `app.listen` vedle lidí: `refreshProductsFromSheet().catch(...)` + `setInterval(..., 5*60*1000)`.

Protože spotřebitelé (`loadAllShifts`, route `/dashboard`, generátor, CSV) čtou tyto struktury **synchronně**, musí zůstat modulové live `let` a být **seedované hned** (init na startu zaručí data před prvním requestem, stejně jako u lidí).

### 4.3 Čistá transformace `lib/products.js`

```
buildProductStructures(rows, categories)
  → { productMapping, productColors, productCoverage, tradingHierarchy, warnings, rejected }
```

- **`productMapping`**: z řádků `{name, startCol:int, trading, slots:[{o:0,s:NightStart,e:NightEnd},{o:1,…},{o:2,…}]}`, seřazeno podle `startCol`.
- **`productColors`**: `{Name → Color}`; prázdná barva → barva kategorie (fallback).
- **`productCoverage`**: jen řádky s ne-defaultním `CoverageSlots`/`CoverageDays` → `{name:{slots:[…],days}}`.
- **`tradingHierarchy`**: pole kategorií v pořadí `categories`; pro reálné kategorie `subs` = produkty z řádků seskupené podle `Trading` (v pořadí `startCol`); pro „Other" `subs` z fixního seznamu v seedu. `color`/`icon` vždy ze seedu.
- **`warnings`**: řádky s neznámou kategorií, nevalidním `startCol`, nevalidním časem → **vynechány** (jako lidi vynechají neznámou skupinu).
- **`rejected`** (string|null): sheet-level gate — neprázdný, když je list hrubě nekonzistentní (viz §7 R1): duplicitní/překrývající se `startCol`, žádný platný produkt, `startCol` mimo 2–52. Pak loader **drží seed** a list neaplikuje (přísnější než lidi — chyba sloupce poškodí mřížku).

**Validace řádku:** `Name` neprázdný a bez `` ` ``/`${` (reuse guardu z people-admin); `Trading` ∈ kategorie; `StartCol` celé číslo ≥ 0; časy `^\d{1,2}:\d{2}$`.

Čisté, bez I/O. Testy `scripts/test-products.js` (viz §8).

### 4.4 Migrace `scripts/migrate-products-to-sheet.js`

Stejný tvar jako `migrate-people-to-sheet.js` (idempotentní):
1. `require('../index.js')` → `{ doc, productMapping, productColors, productCoverage }`; `await doc.loadInfo()`.
2. Chybí list `Products` → `doc.addSheet({ title:'Products', headerValues:[…12 sloupců…] })`.
3. **Idempotence:** má-li list už řádky, jen vypíše počet a skončí (nepřepisuje).
4. Jinak `addRows` z live `productMapping`+`productColors`+`productCoverage`.
5. Per-produkt kontrolní výpis (název → startCol → trading). `.catch` → `process.exit(1)`.

**Vytvořit, NEspouštět** automaticky (pustí ho David ručně, jako u lidí).

### 4.5 Úpravy v `index.js`

- Přidat `TRADING_CATEGORIES` + `PRODUCTS_SEED` (modulová úroveň, ~u dnešního `productMapping`).
- `productMapping`/`productColors`/`productCoverage` z `const` → **live `let`** seedované přes `buildProductStructures`. Přidat live `let tradingHierarchy`.
- **Odstranit route-local `tradingHierarchy`** (`index.js:3405-3415`) — route i `getProductColor` čtou modulovou live verzi.
- **Odstranit ruční duplikát `productsByTrading`** (`index.js:5317`) — odvodit z live `tradingHierarchy` (serializovat subs do klienta).
- `refreshProductsFromSheet()` + wiring startup/interval (`~index.js:6719-6720`).
- (Volitelně, pro paritu s Fází 3) `ensureProductsSheetSeeded()` analog k `ensurePeopleSheetSeeded` (`index.js:817-829`).
- `module.exports` beze změny rozhraní (`productMapping`, `productCoverage`, `getProductMeta`, `getCoverageProfile`, `doc` zůstávají exportované pro scripty — teď ukazují na live `let`).

> **Pozor (template-literal past, CLAUDE.md):** route-local→modulové přesuny i nové serializace do klientského JS musí používat `\${...}` správně a nesmí pustit `` ` ``/`${` z dat. To pokrývá validace v §4.3.

---

## 5. Datový model (Sheets)

**List `Products`** (13 řádků; ukázka prvních 3 + jeden override):

| Name | Trading | Color | StartCol | NightStart | NightEnd | MorningStart | MorningEnd | AfternoonStart | AfternoonEnd | CoverageSlots | CoverageDays |
|------|---------|-------|----------|-----------|----------|--------------|------------|----------------|--------------|---------------|--------------|
| Valhalla Cup A | FIFA | #f44336 | 2 | 22:55 | 06:44 | 06:55 | 14:48 | 14:55 | 22:47 | | |
| Valhalla Cup B | FIFA | #ff5722 | 6 | 22:57 | 06:46 | 06:57 | 14:50 | 14:57 | 22:49 | | |
| … | … | … | … | … | … | … | … | … | … | | |
| Table Tennis | Table Tennis | #00bcd4 | 42 | 23:00 | 07:00 | 07:00 | 15:00 | 15:00 | 23:00 | *(dle dnešního overridu)* | *(dle dnešního overridu)* |

Prázdné `Color` → barva kategorie. Prázdné `CoverageSlots`/`CoverageDays` → default `0,1,2` / `all`. Pořadí řádků nehraje roli (řadí se podle `StartCol`).

**Kategorie (zůstávají v kódu, `TRADING_CATEGORIES`):** FIFA `#fbc02d` ⚽, NBA `#2196f3` 🏀, Cricket `#4caf50` 🏏, Duels `#9c27b0` ⚔, eTouchdown `#795548` 🏈, Table Tennis `#00bcd4` 🏓, Tanks `#607d8b` 🔫, Hockey `#e91e63` 🏒, Other `#607d8b` 📋 (subs: Stand Up, 1on1, All Hands, Training, Interview, Other Event, RIP, Vacation).

---

## 6. Soubory

| Soubor | Akce | Co |
|--------|------|----|
| `lib/products.js` | **Create** | čistá `buildProductStructures` |
| `scripts/test-products.js` | **Create** | unit testy (node, bez frameworku) |
| `scripts/migrate-products-to-sheet.js` | **Create** | idempotentní seed listu `Products` (NEspouštět) |
| `docs/superpowers/plans/2026-06-19-faze2b-produkty-do-sheetu.md` | **Create** | implementační plán (další krok po schválení) |
| `index.js` | **Modify** | seed/const→let/refresh/wiring; odstranit route-local `tradingHierarchy` + duplikát `productsByTrading` |

Spotřebitelé, kteří **musí** dál fungovat beze změny chování (ověřit): `loadAllShifts` (640), `/export-csv` (1677-1716), `getProductMeta`/`getCoverageProfile`, generátor + validátor (974-1137), `/stats` (2771), `getProductColor` + timeline rows (3616) + sidebar (4307) + modal (4438), serializace `pColorsProduct`/`tColors`/`_productList`/`PA_PRODUCTS`, `/api/commit-to-schedule` (6632), `writeCapabilityRow` (835), `lib/local-solver.js`, `scripts/{commit-to-schedule,clear-schedule-cells,batch-local-solver,preview-prompt,generate-live}.js`.

---

## 7. Rizika a ošetření

| # | Riziko | Ošetření |
|---|--------|----------|
| R1 | Špatný `startCol` v listu tiše rozhodí čtení/zápis mřížky | Přísná validace + **sheet-level gate `rejected`** (duplicitní/překrývající/mimo-rozsah `startCol` → list se neaplikuje, drží se seed). Acceptance: diff `loadAllShifts` před/po. |
| R2 | `tradingHierarchy` byl route-local; přesun na modul může změnit render | Behavior-preserving; ověřit identický HTML/JS dashboardu (timeline rows, sidebar, modal). |
| R3 | Drift 3 ručních kopií (`tradingHierarchy`/`productsByTrading`/`productMapping`) | Jeden zdroj pravdy — vše odvozeno z `buildProductStructures`; duplikát smazán. |
| R4 | Ztráta „Other" pseudo-produktů (Vacation/RIP/…) | Zůstávají v `TRADING_CATEGORIES` seedu; ověřit modal + timeline rows. |
| R5 | `` ` ``/`${` v názvu produktu z listu rozbije stránku | Validace názvu (guard z people-admin); vadný řádek vynechán. |
| R6 | Latence Sheets při startu (list navíc) | Seed init zaručí data před 1. requestem; refresh async + interval (jako lidi). |
| R7 | Sloty/coverage se rozejdou se skrytými heuristikami (`stats.js:slotOfStart`, `classifyExistingSlot`) | 2B nemění časy slotů (seed = dnešní hodnoty); heuristiky zůstávají; pokryto regresním diffem. |

---

## 8. Ověření (acceptance criteria)

1. `node scripts/test-products.js` — všechny testy projdou (rekonstrukce `productMapping`/`productColors`/`productCoverage`/`tradingHierarchy` ze seedu identická; neznámá kategorie → warning+skip; nevalidní `startCol`/čas → warning+skip; duplicitní/překrývající `startCol` → `rejected`).
2. Klientský JS dashboardu je validní (extrahovat `<script>` z renderu, `node -c`).
3. **Bez listu `Products`**: dashboard se vykreslí **identicky** jako dnes (seed cesta) — timeline product rows, sidebar, barvy, modal dropdowny.
4. **S listem `Products`** (zaseedováno migrací): dashboard, CSV, `/stats`, generátor-preview produkují **identický** výstup (diff před/po).
5. `loadAllShifts` vrací identické záznamy směn (sloupcová matematika beze změny).
6. Server **nespadne** při chybějícím/prázdném/vadném listu `Products` (fallback na seed; warning v logu); vadný `startCol` se neprojeví do mřížky (R1 gate).
7. `/api/commit-to-schedule` zapisuje do identických buněk (smoke test na testovacím měsíci).

---

## 9. Otevřené otázky

1. **Model listu:** jeden list `Products` + kategorie napevno v kódu (doporučeno, zrcadlí 2A) — vs. zvlášť list `TradingCategories`? *(Doporučuji jeden list.)*
2. **„Other" pseudo-produkty** (Vacation/RIP/Training/…): zůstat napevno v seedu kategorií (doporučeno) — vs. přesunout do listu jako řádky bez `startCol`?
3. **Scope 2B** = jen data-do-Sheetu, behavior-preserving; admin formulář na produkty = Fáze 3? *(Doporučuji ano.)*
4. **Kódování slotů:** 6 sloupců (Night/Morning/Afternoon Start/End) — vs. jeden zhuštěný sloupec? *(Doporučuji 6 sloupců, čitelné a editovatelné ručně.)*
5. **Bonus bugfix:** opravit při téže fázi `/exchange-shift` rozsah `A1:AQ500` → `A1:BG500` (reálný bug: World of Tanks/eHockey nejdou vyměnit) a `commit-to-schedule.js:220` (`slotIndex` → `slot.o`)? *(Doporučuji ano — malé, související.)*
