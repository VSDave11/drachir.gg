# Fáze 2A — Lidé do Sheetu (design)

**Projekt:** muj-kalendar (drachir) — směnový plánovací dashboard
**Datum:** 2026-06-16
**Stav:** návrh ke schválení
**Předchůdce:** Fáze 1 (bezpečný základ) — hotová, v `main`

> Technické názvy (funkce, soubory, sloupce) jsou záměrně v angličtině, ať sedí s kódem.

---

## 1. Kontext a pozice v roadmapě

Celková roadmapa upgradů má 6 fází (viz spec Fáze 1). Fáze 2 = „přesun lidí a produktů z kódu do Sheetu". Po dohodě je **rozdělena**:

- **Fáze 2A — Lidé do Sheetu** ← *tento dokument*
- Fáze 2B — Produkty do Sheetu (později; složitější kvůli `startCol` a kategoriím)
- Fáze 3 — Admin UI pro přidávání lidí/produktů na webu (staví na 2A/2B)

**Proč lidé první:** je to uživatelova hlavní priorita („musíme mít kde přidávat lidi") a datově čistší než produkty. Po 2A je seznam lidí řízený Sheetem, takže Fáze 3 už jen přidá formulář, který do listu zapisuje.

---

## 2. Cíle a ne-cíle

### Cíle
1. Seznam lidí (kdo existuje, jejich skupina a barva) žije v Google Sheetu, ne natvrdo v kódu.
2. Appka načítá lidi z listu při startu; když list chybí, bezpečně spadne zpět na zabudovaný seed (nikdy nespadne).
3. `Lima` příznak (limský čas) se odvozuje ze skupiny `Traders - Lima` (jeden zdroj pravdy).
4. Žádná regrese: dashboard, statistiky i generátor vidí stejné lidi/barvy jako dnes (až na opravu Kevin R. → nově dostane limský čas, viz §3).

### Ne-cíle (řeší pozdější fáze)
- Admin UI pro přidávání/editaci lidí na webu → Fáze 3.
- Přesun produktů, `tradingHierarchy`, `productColors` → Fáze 2B.
- Přesun `PERSON_ALIASES` do Sheetu (zůstává v kódu — týká se normalizace cizích zápisů jmen z BambooHR/Sheets, ne kanonického seznamu).
- Přesun definic skupin (label/barva/cíl hodin) do Sheetu (zůstávají v kódu — 7 rolí se prakticky nemění).

---

## 3. Současný stav (ověřená fakta)

| Konstanta | Co obsahuje | Místo |
|-----------|-------------|-------|
| `peopleHierarchy` | pole 7 skupin `{ label, color, target, members[] }`, ~58 lidí | `index.js:501-509` |
| `personColors` | mapa `jméno → hex barva` (~58) | `index.js:423-483` |
| `LIMA_MEMBERS` | `Set` 14 limských jmen → řídí zobrazení limského času | `index.js:221` |
| `PERSON_ALIASES` | mapa variant zápisu jména → kanonický tvar | `index.js:542-551` |
| `normalizePersonName()` | rozdělí „A + B" a aplikuje aliasy | `index.js:555+` |

**Zjištěná nesrovnalost:** `Kevin R.` je členem skupiny `Traders - Lima` (`peopleHierarchy`), ale není v `LIMA_MEMBERS`. Po odvození Lima ze skupiny začne dostávat limský čas — potvrzeno jako žádoucí oprava.

**Konzumenti** (čtou `peopleHierarchy` / `personColors` / `LIMA_MEMBERS` synchronně): dashboard render (`GET /dashboard`), `/stats`, AI generátor a validátor, CSV export, sidebar. Proto je nutné zachovat synchronní přístup (viz §4).

---

## 4. Návrh

### 4.1 List `People` (nový Google Sheet)
| Sloupec | Význam |
|---------|--------|
| `Name` | kanonické jméno (přesně jako dnes v `peopleHierarchy`) |
| `Group` | jeden z 7 známých labelů skupin |
| `Color` | hex barva osoby (ze `personColors`) |

Pořadí řádků v listu = pořadí zobrazení v rámci skupiny. `Lima` se **neukládá** (odvozuje se z `Group === "Traders - Lima"`).

### 4.2 Načítání (modulové `let` + load při startu)
**Zvolený přístup** (nejméně invazivní, drží synchronní přístup konzumentů):

- `peopleHierarchy`, `personColors`, `limaSet` budou **modulové `let` proměnné**, inicializované zabudovaným **seedem** (dnešní natvrdo zadaná data) jako fallback.
- Funkce `refreshPeopleFromSheet()` načte list `People`, a když existuje a má řádky, **přepíše** modulové proměnné výsledkem `buildPeopleStructures(rows)`. Když list chybí/je prázdný → ponechá seed + zaloguje warning.
- Volá se **při startu před `app.listen`** (čeká se na dokončení) a dál se obnovuje s 5min cache (vzor `loadCapabilities`). Ve Fázi 3 se zavolá hned po zápisu.

### 4.3 Čistá transformace `lib/people.js`
Testovatelná funkce bez I/O:
```
buildPeopleStructures(rows, GROUPS) -> { peopleHierarchy, personColors, limaSet }
```
- `rows`: `[{ Name, Group, Color }]` z listu.
- `GROUPS`: zabudované definice skupin `[{ label, color, target }]` (pořadí = pořadí skupin v UI).
- Sestaví `peopleHierarchy` (každá skupina + její členové v pořadí z listu), `personColors` (Name→Color, fallback na default barvu když prázdné), `limaSet` (jména ze skupiny `Traders - Lima`).
- Neznámá `Group` (není mezi `GROUPS`): osoba se zaloguje jako varování a **vynechá** z hierarchie (neosiří UI), ať jeden překlep nerozbije celý seznam.

### 4.4 Migrace `scripts/migrate-people-to-sheet.js`
Jednorázový skript:
1. Pokud list `People` neexistuje, vytvoří ho s hlavičkou `Name, Group, Color`.
2. Pro každou skupinu a člena v zabudovaném seedu zapíše řádek `{ Name, Group: <label skupiny>, Color: personColors[name] || '' }`, **zachová přesná jména**.
3. Idempotence: pokud list už má řádky, skript **nepřepisuje** (vypíše počet a skončí) — ať se omylem nepřemažou ruční úpravy. (Re-migrace jen na čistý/neexistující list.)
4. Vypíše počet zapsaných lidí a kontrolní součet podle skupin.

### 4.5 Úpravy v `index.js`
- `const peopleHierarchy = [...]` → `let peopleHierarchy = [...]` (seed zůstává jako fallback).
- `const personColors = {...}` → `let personColors = {...}` (seed).
- `LIMA_MEMBERS` (`Set`) → `let limaSet` odvozený; ponechat seed pro fallback. Všechna použití `LIMA_MEMBERS.has(x)` → `limaSet.has(x)`.
- Přidat `require('./lib/people')`, `refreshPeopleFromSheet()`, zavolat ji při startu (await) a nastavit periodický/cache refresh.

---

## 5. Datový model (Sheets)

| List | Změna |
|------|-------|
| `People` (nový) | sloupce `Name, Group, Color` |
| ostatní | beze změny |

Žádný stávající list se nemění.

---

## 6. Soubory

| Soubor | Akce |
|--------|------|
| `lib/people.js` | Create — `buildPeopleStructures` (čistá fce) |
| `scripts/test-people.js` | Create — unit testy |
| `scripts/migrate-people-to-sheet.js` | Create — jednorázová migrace |
| `index.js` | Modify — `let` proměnné, `refreshPeopleFromSheet`, startup load, `limaSet` |

---

## 7. Rizika a ošetření

| Riziko | Ošetření |
|--------|----------|
| Osiřelá jména (neshoda s ManualShifts/Schedule/Capabilities) | Migrace kopíruje kanonická jména ze seedu → shoda konstrukcí. Acceptance test porovná počty. |
| List chybí / nečitelný při startu | Fallback na seed + warning; app vždy naběhne. |
| Neznámá skupina v řádku | Osoba vynechána + warning (nerozbije seznam). |
| Konzumenti čtou data před dokončením startup loadu | Startup load se `await`uje před `app.listen`. |
| Dvojí zdroj pravdy (seed vs list) mate | Seed je jen fallback/seed migrace; po migraci je list jediný živý zdroj. Dokumentováno. |
| Kevin R. začne dostávat limský čas | Potvrzeno jako žádoucí (je v Lima skupině). |

---

## 8. Ověření (acceptance criteria)

1. **Unit:** `node scripts/test-people.js` — `buildPeopleStructures` správně sestaví hierarchii, barvy, limSet; neznámá skupina se vynechá.
2. **Migrace:** po `node scripts/migrate-people-to-sheet.js` má list `People` přesně tolik řádků, kolik je lidí v seedu, se správnými skupinami a barvami; druhý běh nic nepřepíše.
3. **Startup load:** se seedem i s listem server naběhne (`node index.js`); dashboard zobrazí stejné lidi a barvy jako dnes.
4. **Fallback:** když list `People` neexistuje, server naběhne na seed (warning v logu).
5. **Lima:** `limaSet` obsahuje členy skupiny `Traders - Lima` včetně Kevin R.
6. **Smoke:** `node -c index.js`, server boot, `GET /dashboard` (s loginem) zobrazí kompletní seznam lidí.

---

## 9. Otevřené otázky

Žádné blokující. Drobnost: výchozí barva pro osobu bez `Color` — použije se neutrální `#888` (sjednoceno s dnešním fallbackem v kódu).
