# Fáze 3 — Webová správa lidí (admin) — design

**Projekt:** muj-kalendar (drachir)
**Datum:** 2026-06-16
**Stav:** návrh ke schválení
**Předchůdci:** Fáze 1 (bezpečný základ) + Fáze 2A (lidé do Sheetu) — hotové, v `main`

> Technické názvy v angličtině, ať sedí s kódem.

---

## 1. Kontext a pozice v roadmapě

Toto je featura, kvůli které celá série fází vznikla: **admin přidává/spravuje lidi rovnou na webu**, bez ručního sahání do Google Sheetu. Staví přímo na Fázi 2A (seznam lidí už je v listu `People`).

- Produkty jsou **stále natvrdo v kódu** (`productMapping`, 13 ks) — jejich přesun do Sheetu je Fáze 2B. Fáze 3 produkty needituje; pro eligibilitu jen **používá** současný hardcoded seznam 13 produktů.
- Sheet zůstává databází; web je ovládací vrstva (data dál sedí v Sheetu).

---

## 2. Cíle a ne-cíle

### Cíle
1. Admin může na dashboardu **přidat** člověka (jméno, skupina, barva, eligibilita produktů).
2. Admin může **upravit** existujícího člověka (skupina, barva, eligibilita) — **bez přejmenování**.
3. Admin může **odebrat** člověka (z listu `People` i `Capabilities`).
4. Zápis jde do listů `People` a `Capabilities`; appka se po zápisu hned obnoví.
5. Vše **jen pro admina**, CSRF-chráněné, s validací vstupů (vrstvy z Fáze 1).
6. Robustní vůči stavu před migrací (viz §4.5).

### Ne-cíle
- **Přejmenování** člověka (osiřelo by historické směny pod starým jménem) — vynecháno.
- Správa **produktů / trading kategorií** (Fáze 2B).
- Správa **skupin** (7 rolí zůstává v kódu — Fáze 2A rozhodnutí).
- Správa hesel/účtů (`uzivatele` sheet) — mimo rozsah.

---

## 3. Současný stav (na čem stavíme)

| Co | Stav | Místo |
|----|------|-------|
| List `People` (Name, Group, Color) | zaveden ve 2A; načítá `refreshPeopleFromSheet()` do `peopleHierarchy/personColors/limaSet` | `index.js` (loader u seed bloku) |
| `GROUPS` (7 definic skupin) | natvrdo, odvozeno ze seedu | `index.js` |
| `buildPeopleStructures(rows, GROUPS)` | čistá transformace | `lib/people.js` |
| List `Capabilities` | matice: col 0 = jméno, cols 1+ = produkty (hodnoty 1/true/x); `loadCapabilities()` + 5min cache; `GET /api/capabilities` (admin) vrací `byPerson`/`byProduct` | `index.js` |
| `productMapping` (13 produktů) | natvrdo | `index.js` |
| Admin gating | server `if(!req.user||req.user.role!=='Admin') return 403`; client `${req.user.role==='Admin' ? ... : ''}` | `index.js` |
| CSRF | `fetch` wrapper přidává `X-CSRF-Token`; server middleware ověřuje | Fáze 1 |
| Validace | `validateNoTemplateChars(...)` (lib/validate) | Fáze 1 |
| Vzor zápisu do Sheetu | `/api/set-color` (addRow/row.set+save/row.delete na CustomColors); `add-shift` vytvoří list, když chybí | `index.js` |

---

## 4. Návrh

### 4.1 UI — modal „Správa lidí"
- Nové tlačítko **„👥 Správa lidí"** v admin-gated bloku sidebaru (vedle AI GENERATE / SYNC). Renderuje se jen pro `role === 'Admin'`.
- Modal obsahuje:
  - **Seznam lidí** seskupený po skupinách: `barevný puntík · jméno · skupina · [Upravit] [Odebrat]`.
  - **Formulář** (přidat / upravit):
    - `Name` — text (při úpravě read-only, je to klíč),
    - `Group` — `<select>` se 7 skupinami,
    - `Color` — color picker (prázdné → auto default),
    - **eligibilita** — 13 zaškrtávátek (produkty z `productMapping`).
  - Tlačítka: `Přidat` / `Uložit změny` / `Zrušit`.
- Data modalu: při otevření `fetch('/api/admin/people')` → vrátí lidi + jejich produktovou eligibilitu.

### 4.2 Endpointy (vše admin-only + CSRF + validace)
| Route | Payload | Akce |
|-------|---------|------|
| `GET /api/admin/people` | — | vrátí `[{name, group, color, products:[...]}]` (z `People` + `Capabilities`) + seznam všech `groups` a `allProducts` |
| `POST /api/admin/people` | `{name, group, color, products[]}` | přidá řádek do `People`, zapíše Capabilities řádek |
| `POST /api/admin/people/update` | `{name, group, color, products[]}` | najde řádek dle `name`, aktualizuje Group/Color + Capabilities |
| `POST /api/admin/people/remove` | `{name}` | smaže řádek v `People` i v `Capabilities` |

Po každém mutačním endpointu: `await refreshPeopleFromSheet()` + invalidace cache eligibility (`_capsCache`).

### 4.3 Validace a pravidla
- `validateNoTemplateChars(name, group, color)` — odmítne backtick/`${`.
- `group` musí být jeden ze 7 známých (`GROUPS`), jinak 400.
- `name` neprázdné; při **přidání** nesmí už existovat (klíč), jinak 400 „už existuje".
- `color` prázdné → doplní se default (`#888` nebo z palety dle indexu).
- `products[]` — jen názvy z `productMapping`; ostatní se ignorují.

### 4.4 Čistá, testovatelná logika → `lib/people-admin.js`
- `validatePersonInput({name, group, color}, { groups, existingNames, mode })` → `null | chybová hláška` (mode `'add'` kontroluje duplicitu).
- `buildCapabilityRowValues(name, selectedProducts, allProducts)` → objekt `{ <col0header>: name, <product>: 'x'|'' , ... }` pro zápis řádku Capabilities.
- Unit testy (`scripts/test-people-admin.js`).

### 4.5 🔑 Robustnost vůči stavu před migrací
Add/update endpoint **nesmí** vytvořit téměř prázdný list `People` (to by při dalším refreshi smazalo 58 lidí ze živých proměnných). Proto pomocná funkce `ensurePeopleSheetSeeded()`:
- Pokud list `People` neexistuje nebo je prázdný → nejdřív do něj zapíše **všechny současné lidi** (z aktuálního `peopleHierarchy`, což je seed) → teprve pak proběhne přidání/úprava.
- Funguje tedy bez ohledu na to, jestli admin pustil migrační skript z 2A.

---

## 5. Datový model (Sheets)

| List | Změna |
|------|-------|
| `People` | zápis/úprava/mazání řádků (Name, Group, Color) |
| `Capabilities` | zápis/úprava/mazání řádku osoby (jméno + zaškrtnuté produkty) |
| ostatní | beze změny |

Žádný nový list se nezakládá (oba už existují / vytvoří je 2A migrace, příp. `ensurePeopleSheetSeeded`).

---

## 6. Soubory

| Soubor | Akce |
|--------|------|
| `lib/people-admin.js` | Create — `validatePersonInput`, `buildCapabilityRowValues` (čisté) |
| `scripts/test-people-admin.js` | Create — unit testy |
| `index.js` | Modify — 4 endpointy, `ensurePeopleSheetSeeded`, Capabilities read/write helper, admin tlačítko + modal + klientský JS |

---

## 7. Rizika a ošetření

| Riziko | Ošetření |
|--------|----------|
| Add před migrací vytvoří skoro prázdný `People` → ztráta lidí | `ensurePeopleSheetSeeded()` nejdřív nasype celý seed (§4.5) |
| Duplicitní jméno | `validatePersonInput` mode 'add' odmítne |
| Capabilities matice — neznámý sloupec/produkt | zapisují se jen produkty z `productMapping`; chybějící sloupce se doplní do hlavičky |
| Backtick ve jméně rozbije šablonu | validace (Fáze 1) |
| Velký dashboard template literal — nový modal + JS | modal HTML přidat opatrně, klientské `fetch` jdou přes CSRF wrapper; po změně ověřit `node -c` + JS v konzoli |
| Odebrání člověka s historií | směny v datech zůstanou (zmizí jen ze sidebaru) — akceptováno |
| Souběžné zápisy do Sheetu | malý objem, akceptujeme last-write-wins; refresh po zápisu |

---

## 8. Ověření (acceptance criteria)

1. **Unit:** `node scripts/test-people-admin.js` — validace (prázdné jméno, neznámá skupina, duplicita v add), build Capabilities řádku.
2. **Add:** jako admin přidám člověka → objeví se v listu `People`, má řádek v `Capabilities` se zaškrtnutými produkty, hned se zobrazí na dashboardu ve správné skupině s barvou.
3. **Edit:** změna skupiny/barvy/eligibility se uloží a projeví (bez možnosti přejmenovat).
4. **Remove:** odebraný člověk zmizí z `People` i `Capabilities` i ze sidebaru.
5. **Admin-only:** ne-admin dostane na všech `/api/admin/people*` 403; tlačítko „Správa lidí" se ne-adminovi nezobrazí.
6. **Pre-migrace robustnost:** na čistém Sheetu (bez listu `People`) první přidání nejdřív nasype celý seed a pak přidá nového — počet lidí = 59 (seed) + 1.
7. **Smoke:** `node -c index.js`, boot, modal se otevře a načte lidi.

---

## 9. Otevřené otázky

Žádné blokující. Drobnost: default barva pro prázdný color — `#888` (sjednoceno se zbytkem). Eligibilita produktů používá hardcoded `productMapping` dokud neproběhne Fáze 2B.
