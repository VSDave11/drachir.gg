# Fáze 1 — Bezpečný základ (design)

**Projekt:** muj-kalendar (drachir) — směnový plánovací dashboard
**Datum:** 2026-06-16
**Stav:** návrh ke schválení
**Autor:** David Kuchař + Claude

> Technické názvy (funkce, soubory, sloupce, routy) jsou záměrně v angličtině, ať sedí s kódem.

---

## 1. Kontext a celá cesta (roadmap)

Appka má dostat řadu upgradů. Po analýze kódu jsme se domluvili rozdělit práci do fází; každá má vlastní spec → plán → implementaci a dá se po ní bezpečně zastavit.

| Fáze | Obsah | Stav |
|------|-------|------|
| **1. Bezpečný základ** | Hashování hesel, CSRF, secret do env, UUID u směn, dedup produktů, validace zpětných uvozovek, audit prohlížečka (F4) | **tento dokument** |
| 2. Data do Sheetu (F6) | Přesun lidí (58) a produktů (13) z kódu do Google Sheetu | později |
| 3. Admin přidávání (F3) | Formuláře „přidat člověka / produkt", jen pro admina | později |
| 4. Řazení sloupců (F1) | Per-uživatel pořadí lidí/tradingu | později |
| 5. Multi-select (F2) | CTRL výběr + hromadné smazání/úprava | později |
| 6. Statistiky (F5) | Trading rozpad + pokrytí do `/stats` | později |

**Proč je Fáze 1 první:** zabezpečí app a dá adminovi přehled (audit) dřív, než pozdější fáze začnou hromadně měnit klíčová data. Tyhle věci jsou levné teď a drahé dodělávat zpětně. Zároveň F2 (hromadné mazání) přímo závisí na UUID z této fáze.

---

## 2. Cíle a ne-cíle Fáze 1

### Cíle
1. Hesla v Sheetu už nejsou čitelná v plaintextu (hash + sůl).
2. Tajný klíč není v kódu, ale v env proměnné.
3. Stav-měnící POST requesty jsou chráněné CSRF tokenem.
4. Každá směna má stabilní `Id` (UUID); úpravy/mazání už nejedou podle čísla řádku.
5. Seznam produktů je v kódu jen jednou (žádná druhá kopie, co tiše rozbije CSV).
6. Žádný zápis do Sheetu neprojde se zpětnou uvozovkou / `${` (ochrana před rozbitím stránky).
7. Admin má v UI prohlížečku audit logu (F4).

### Ne-cíle (řeší pozdější fáze)
- Přesun lidí/produktů do Sheetu (Fáze 2) — Fáze 1 se hardcoded dat **nedotýká**.
- Jakákoli změna vzhledu dashboardu mimo přidání admin odkazu na audit log.
- Vytažení klientského JS z template literalu — naplánováno až před Fázi 4/5.
- Multi-select samotný (Fáze 5); zde jen připravíme UUID, na kterém stojí.

---

## 3. Současný stav (ověřená fakta)

| Oblast | Realita dnes | Místo |
|--------|--------------|-------|
| Session secret | `COOKIE_SECRET = 'drachir-viking-secret-2026'` natvrdo v kódu; používá se pro session cookie **i** remember-me HMAC token | `index.js:12`, použití `:14,23,29` |
| Hesla | Plaintext porovnání `heslo === passwordInput` proti sheetu `uzivatele` | `index.js:1257`; změna hesla `:1436-1490` |
| `uzivatele` sheet | sloupce: `jmeno, email, heslo, role, location, slack_id` (detekce podle hlavičky) | `index.js:1242-1251` |
| CSRF | žádná ochrana na žádném POST | — |
| ManualShifts | sloupce `Date, Name, Trading, Product, Start, End, Note, AddedBy`; úpravy/mazání podle indexu řádku `_row` (1-based) | add `:1987-2016`, update `:2067-2112`, delete `:2115-2165` |
| productMapping | definováno na úrovni modulu **a** duplicitně v CSV exportu | `index.js:489-503` a `:1524-1538` |
| Backtick past | jméno se `` ` `` nebo `${` rozbije celou stránku bez chyby; `safe()` strhává jen uvozovky | CLAUDE.md:30-34 |
| AuditLog | sheet `Timestamp, Jmeno, Email, Role, Location, Action` (+ Detail); zapisují se LOGIN, ADD/EDIT/DELETE_SHIFT, EXCHANGE, DELETE_MONTH, CHANGE_PASSWORD, AI_GENERATE_COMMIT | zápisy `:1282,2009,2103,2156,2194,2272,1486,6076` |
| Audit prohlížečka | **neexistuje**; jen `GET /api/shift-history` pro jednu směnu | `index.js:1610-1640` |
| Admin gating | funkční vzor: server `if (!req.user || req.user.role !== 'Admin') return 403` + client `${req.user.role==='Admin' ? ... : ''}` | `:1644,1721,...` / `:3883-3887` |

---

## 4. Detailní návrh

Rozhodnuté volby (uživatel nechal na doporučení): **scrypt**, **samostatná stránka** pro audit, **bezpečnost první**.

### 1A. Hashování hesel — `crypto.scrypt`

- **Formát uloženého hesla:** `scrypt$<saltHex>$<hashHex>`. Prefix `scrypt$` slouží k detekci „už zahashováno".
- **Pomocné funkce** (nové, module-level):
  - `hashPassword(plain)` → vygeneruje 16B sůl, `crypto.scryptSync(plain, salt, 64)`, vrátí string `scrypt$salt$hash`.
  - `verifyPassword(plain, stored)` → pokud `stored` začíná `scrypt$`, porovná `timingSafeEqual`; jinak (legacy plaintext) porovná `plain === stored` a vrátí `{ ok, legacy:true }`.
- **Líná migrace při loginu** (`index.js:1257`):
  1. Najdi uživatele podle emailu.
  2. `verifyPassword(passwordInput, heslo)`.
  3. Když `ok && legacy` → zapiš `hashPassword(passwordInput)` zpět do buňky `heslo` (jednorázový upgrade toho uživatele).
- **Change-password** (`:1436-1490`): porovnání starého přes `verifyPassword`, uložení nového vždy přes `hashPassword`.
- **Bez nové závislosti** (scrypt je v `crypto`, už importováno na `index.js:5`).

### 1B. Tajný klíč do env + CSRF

- **Secret:** `const COOKIE_SECRET = process.env.SESSION_SECRET || 'drachir-viking-secret-2026';`
  - Na Renderu se nastaví `SESSION_SECRET` (do `render.yaml` přidat `sync: false` proměnnou).
  - **Důsledek:** jakmile se na Renderu nastaví nový secret, existující remember-me cookies a session se zneplatní → uživatelé se jednou znovu přihlásí. Akceptováno; zmíníme při nasazení.
- **CSRF (synchronizer token, bez závislosti):**
  - Middleware zajistí `req.session.csrf` (vygeneruje `crypto.randomBytes(32).hex` při prvním requestu).
  - Token se vloží do dashboardu jako `<meta name="csrf-token" content="...">` a do JS proměnné.
  - Klient: malý wrapper / úprava `fetch` volání přidá hlavičku `X-CSRF-Token` na všechny non-GET requesty.
  - Server: middleware na všech `POST/PUT/DELETE` ověří `req.headers['x-csrf-token'] === req.session.csrf`, jinak `403`. **Výjimka:** `POST /login` (uživatel ještě nemá session) — chráněn jinak (rate-limit mimo scope, zatím vynecháno z CSRF).

### 1C. UUID u směn

- Do sheetu `ManualShifts` přidat sloupec **`Id`**.
- `POST /add-shift`: vygeneruj `crypto.randomUUID()`, ulož do `Id`.
- Načítání směn (`loadAllShifts`): přenes `Id` do shift objektu (`s._id`).
- `update-shift` / `delete-shift`: primárně hledej řádek podle `Id`; fallback na stávající klíč (`Date|Name|Start`) kvůli starým řádkům bez `Id`.
- **Backfill:** jednorázová idempotentní funkce při startu (nebo skript `scripts/backfill-shift-ids.js`) doplní `Id` všem ManualShifts řádkům, které ho nemají.
- `Schedule-*` sheety zůstávají read-only (mazání jen z cache) — beze změny.

### 1D. Sloučení duplicitního productMapping

- Druhou kopii (`index.js:1524-1538`) nahradit referencí na jediný module-level `productMapping` (`:489-503`).
- Žádná funkční změna; ověřit, že CSV export dává stejný výstup jako dřív (manuální diff před/po).

### 1E. Validace zpětných uvozovek

- Sdílená funkce `validateNoTemplateChars(...values)` → vrátí chybu, pokud kterákoli hodnota obsahuje `` ` `` nebo `${`.
- Použít na vstupních polích všech zápisových rout: `/add-shift`, `/update-shift`, `/change-password` (Note/jména), a připravit pro budoucí people/products zápisy.
- Při porušení: `res.status(400).json({ error: 'Neplatný znak (zpětná uvozovka) v poli X' })`.

### 1F. Audit prohlížečka (F4) — `GET /admin/audit-log`

- **Jen pro admina** (server 403 vzor + odkaz v UI gated `${req.user.role==='Admin'}`).
- Načte sheet `AuditLog`, default **posledních 90 dní** (filtr podle `Timestamp`).
- Renderuje tabulku: **Čas | Kdo (Jmeno) | Akce | Detail**.
- Filtry (query params + klientské): osoba, typ akce (LOGIN / ADD_SHIFT / …), rozsah dat.
- Stránkování (např. 200 řádků/stránka) kvůli rychlosti.
- Parsování `Action` (pipe-delimited): při selhání zobraz surový řetězec, nerozbij se.

---

## 5. Změny datového modelu (Sheets)

| Sheet | Změna |
|-------|-------|
| `ManualShifts` | + sloupec `Id` (UUID) |
| `uzivatele` | beze změny schématu; obsah sloupce `heslo` se postupně mění z plaintextu na `scrypt$…` |
| `AuditLog` | beze změny (jen nové čtení) |

Žádný nový sheet se v Fázi 1 nezakládá.

---

## 6. Pořadí implementace (commity)

1. **Bezpečnost:** secret → env, scrypt hashování + líná migrace, CSRF middleware + klient. *(commit 1–2)*
2. **UUID:** sloupec `Id`, add/update/delete podle `Id`, backfill. *(commit 3)*
3. **Dedup productMapping** + **validace backticků**. *(commit 4)*
4. **Audit prohlížečka** `/admin/audit-log` + odkaz v UI. *(commit 5)*

Každý krok je samostatně nasaditelný a testovatelný.

---

## 7. Rizika a ošetření

| Riziko | Ošetření |
|--------|----------|
| Migrace hesel někoho vyhodí | Líná migrace: legacy plaintext se ověří postaru a teprve pak upgraduje. Nikdo se neodhlásí kvůli hashování. |
| Změna secretu odhlásí všechny | Akceptováno (jednorázové). Naplánovat nasazení mimo špičku, informovat tým. |
| CSRF rozbije existující `fetch` | Token přidán centrálně (wrapper); projít všechna `fetch` POST volání a ověřit hlavičku. GET nedotčené. |
| UUID backfill poškodí data | Idempotentní, doplňuje jen prázdné `Id`; spustit nejdřív na kopii sheetu / ověřit počty řádků před a po. |
| Audit log moc velký → pomalá stránka | Default 90 dní + stránkování; plný rozsah jen na vyžádání filtrem. |
| Rozbití stránky během vývoje | Po každém kroku ověřit klientský JS přes `node -c` (extrahovaný `<script>`), CLAUDE.md:debugging. |
| Orphan node procesy na Windows | `taskkill //F //IM node.exe` před restartem (CLAUDE.md:36-38). |

---

## 8. Ověření (acceptance criteria)

Bez test frameworku — manuální + skripty (`node scripts/...`), v souladu s CLAUDE.md.

1. **Hesla:** po prvním přihlášení stávajícího uživatele je jeho `heslo` v sheetu ve formátu `scrypt$…`; přihlášení stejným heslem dál funguje; špatné heslo selže.
2. **Secret:** s nastaveným `SESSION_SECRET` login + dashboard funguje; bez něj (lokálně) taky (fallback).
3. **CSRF:** POST bez hlavičky `X-CSRF-Token` vrátí 403; běžné akce z UI (add/edit/delete shift) procházejí.
4. **UUID:** nová směna má `Id`; smazání konkrétní směny smaže právě ji i po předchozím smazání jiné (žádný posun); backfill doplní ID starým řádkům.
5. **Dedup:** CSV export dává identický výstup jako před změnou.
6. **Validace:** pokus uložit směnu s `` ` `` ve jménu/poznámce → 400, stránka se nerozbije.
7. **Audit:** `/admin/audit-log` jako admin zobrazí filtrovatelnou tabulku posledních 90 dní; jako ne-admin vrátí 403.

---

## 9. Otevřené otázky

Žádné blokující. Případné doladění UI audit logu (sloupce, výchozí filtr) při implementaci.
