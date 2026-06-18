# Fáze 6 — Statistiky: Trading rozpad (design)

**Projekt:** muj-kalendar (drachir) — směnový plánovací dashboard
**Datum:** 2026-06-18
**Stav:** návrh ke schválení / v implementaci
**Předchůdci:** Fáze 1 (bezpečný základ), 2A (lidé do Sheetu), 3 (web správa lidí) — hotové, v `main`

> Technické názvy v angličtině, ať sedí s kódem.

---

## 1. Kontext a pozice v roadmapě

Z roadmapy (spec Fáze 1) zbývá Fáze 6 = **„Statistiky — trading rozpad + pokrytí do `/stats`"**. Stránka `/stats` (`index.js:2591+`) už existuje a je bohatá: per-osoba KPI pro den/týden/měsíc, trend hodin, donut, team overview. Rozpadá ale směny **jen podle denní doby** (morning / afternoon / night / RIP / vacation). **Chybí pohled „co se obchoduje"** — kolik hodin/směn padlo na jednotlivé trading kategorie a produkty.

Tato fáze je rozdělená:
- **6A — Trading rozpad** ← *tento dokument*. Čistě odvozené z existujících dat směn (`Trading` / `Product` pole), žádný nový vstup.
- **6B — Pokrytí (coverage)** — později. Vyžaduje zdroj „požadovaného pokrytí" (kolik směn má každý produkt mít), což je rozhodnutí (criteria.md vs. nový list). Mimo rozsah 6A.

**Proč 6A první:** je plně odvoditelná z dat, která už máme, nese okamžitou hodnotu (manažerský pohled „kolik kapacity jde na FIFA vs. NBA…"), je čistě testovatelná a nesahá na křehkou hlavní dashboard šablonu — jen rozšiřuje samostatnou stránku `/stats`.

---

## 2. Cíle a ne-cíle

### Cíle
1. Na `/stats` přidat panel **Trading breakdown**: hodiny + počet směn rozpadnuté podle **trading kategorie** (FIFA, NBA, Cricket, Duels, eTouchdown, Table Tennis, Tanks, Hockey) a uvnitř každé kategorie podle **produktu**.
2. Zobrazit ve **team overview** (celý tým, měsíc) i v **detailu osoby** (jen daná osoba, měsíc).
3. Vyloučit ne-tradingové směny (`RIP`, `Vacation`).
4. Čistá, unit-testovaná agregační logika v `lib/stats.js` (vzor `lib/people.js`, `lib/people-admin.js`).
5. Žádná regrese existujícího `/stats`; bezpečné vůči backtickům/`${` v názvech produktů z Sheetu.

### Ne-cíle
- **Coverage / pokrytí** požadavků (Fáze 6B).
- Změny hlavního dashboardu (`GET /dashboard`).
- Nové filtry/období nad rámec existujících (den/týden/měsíc kotvené `?date=`).
- Export rozpadu do CSV (případně později).

---

## 3. Současný stav (na čem stavíme)

| Co | Stav | Místo |
|----|------|-------|
| `/stats` route | per-osoba KPI (den/týden/měsíc), trend, donut, team overview; rozpad jen dle denní doby | `index.js:2591+` |
| `allShifts` (deduped) | sestavené v route z `loadAllShifts()` | `index.js:2628-2637` |
| ranges day/week/month | `dayStart..monthEnd` | `index.js:2604-2615` |
| `calculateDuration(start,end)` | hodiny směny (i přes půlnoc) | `index.js:1331` |
| `productMapping` | 13 produktů s polem `trading` | `index.js:541-555` |
| `mainHTML` interpolace | `${mainHTML}` v template literalu | `index.js:3206` → **nutné escapovat backtick/`${`/HTML v názvech** |
| Vzor čisté logiky + testů | `lib/*.js` + `scripts/test-*.js` | repo |

---

## 4. Návrh

### 4.1 Čistá logika → `lib/stats.js`
```
buildTradingBreakdown(shifts, durationFn, opts) -> { categories, totalHours, totalShifts }
```
- `shifts`: `[{ Trading, Product, Start, End }]` (už odfiltrované na období).
- `durationFn`: `(start,end) => hodiny` (injektujeme `calculateDuration`).
- `opts.excludeProducts`: názvy produktů k vyloučení (`['RIP','Vacation']`).
- `categories`: `[{ trading, hours, shifts, products:[{product, hours, shifts}] }]`, seřazené sestupně dle hodin (tie-break dle názvu); produkty uvnitř též.
- Odolné: `null` prvky přeskočí, prázdné `Trading` → `'Other'`, prázdný `Product` → `'(none)'`, NaN/záporné hodiny → `0`, hodiny zaokrouhlené na 1 desetinné místo.

### 4.2 UI v `/stats`
- Helper `renderTradingPanel(shifts, title, periodLabel)` — postaví panel (stejný `.panel` styl jako okolí): řádek na kategorii (barevný čip, název, bar dle podílu hodin, `Xh · N shifts`) a pod ním produktové pod-řádky.
- Barvy kategorií: pevná paleta indexovaná pořadím (deterministické, self-contained — netahá `tradingHierarchy`, který je mimo scope `/stats`).
- **Team overview:** panel za sekcí MONTH (celý tým, měsíční období).
- **Detail osoby:** panel v sekci MONTH (směny dané osoby).
- Prázdný stav: „NO TRADING SHIFTS".

### 4.3 Bezpečnost
- Lokální helper `tclean(v)` odstraní backtick → `'`, `${` → `$ {`, a `<`/`>` → entity. Použít na **všechny** názvy z dat (`trading`, `product`) před vložením do `mainHTML` (chrání template literal i proti HTML injection).

---

## 5. Datový model (Sheets)
Beze změny. 6A jen **čte** existující směny. Žádný nový list.

---

## 6. Soubory

| Soubor | Akce |
|--------|------|
| `lib/stats.js` | Create — `buildTradingBreakdown` (čistá) |
| `scripts/test-stats.js` | Create — unit testy |
| `index.js` | Modify — import, `renderTradingPanel` + `shiftsInRange` helpery, panely v team/person MONTH |

---

## 7. Rizika a ošetření

| Riziko | Ošetření |
|--------|----------|
| Backtick/`${` v názvu produktu rozbije `/stats` | `tclean()` na všech názvech |
| Off-by-one u hranic období | použít **stejný** vzor porovnání jako existující `computeStats` (`new Date(s.Date)` vs. range), žádná nová logika dat |
| Regrese existujícího `/stats` | jen přidání panelů; `node -c` + boot + vizuální kontrola |
| Směny bez `Trading` | spadnou do `'Other'` (nezmizí) |
| `getProductColor`/`tradingHierarchy` mimo scope `/stats` | nepoužívat; vlastní paleta |

---

## 8. Ověření (acceptance criteria)
1. **Unit:** `node scripts/test-stats.js` — seskupení dle Trading+Product, řazení dle hodin, exclude RIP/Vacation, Other/(none), odolnost (null, NaN).
2. **Smoke:** `node -c index.js`, server naběhne.
3. **Team overview:** sekce MONTH ukáže Trading breakdown s kategoriemi seřazenými dle hodin, součty sedí.
4. **Detail osoby:** panel ukáže rozpad jen dané osoby.
5. **Bezpečnost:** název produktu s backtickem stránku nerozbije (zobrazí se jako `'`).
6. **Žádná regrese:** existující KPI/trend/donut/team listy fungují beze změny.

---

## 9. Otevřené otázky
Žádné blokující pro 6A.

---

## 10. Fáze 6B — Coverage (implementováno 2026-06-18)

Zdroj požadovaného pokrytí **není** nový vstup — bere se z existujícího `productCoverage` / `getCoverageProfile()` (`index.js`), což přesně odpovídá criteria.md §2 (default 24/7; World of Tanks = jen ranní Po–Pá; eHockey = ranní+odpolední každý den).

- **Logika** (`lib/stats.js`): `slotOfStart(start)` (noční/ranní/odpolední dle hodiny, pokrývá všechny start časy z productMapping) + `buildCoverage(shifts, productProfiles, periodDates)` → per produkt `{expected, covered, gaps, pct, gapDates}` + celkové součty; slot `(produkt,den,slot)` je „covered", když existuje aspoň jedna směna toho produktu/dne/slotu; řazeno nejhorší pct první.
- **UI** (`/stats`): panel **COVERAGE** v team overview (měsíc) — per produkt bar + `covered/expected slots` + % + počet dnů s mezerou; barva zelená ≥95 %, žlutá ≥80 %, červená jinak.
- **Pozn.:** měří se proti **definovanému** coverage profilu, ne proti „někdo tam byl" — produkt může mít směny (trading rozpad), ale 0 % coverage, pokud nejsou v jeho definovaném okně (typicky World of Tanks / eHockey). Coverage zahrnuje i budoucí dny měsíce (nenaplánované dny = mezery).
- **Testy:** `scripts/test-stats.js` #7–#9 (slotOfStart, expected/covered/gaps, weekdays vyloučení víkendu). Ověřeno živě: 10 produktů 100 %, reálné mezery u WoT/eHockey/Table Tennis.
