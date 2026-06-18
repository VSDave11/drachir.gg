# Fáze 5 — Multi-select + hromadné mazání: Spec + Plán (ready-to-implement)

> **Stav:** návrh připraven k implementaci. Implementace odložena na chvíli, kdy je u toho David s prohlížečem — feature je **destruktivní** (mazání směn) + **interaktivní** (výběr v UI), což nejde bezpečně ověřit autonomně (klikání v prohlížeči + reálné mazání ostrých dat). Pure logika + endpoint guardy se otestují, klient/UX a ostré smazání ověří David.

**Goal:** Na dashboardu vybrat víc směn (Ctrl-klik / checkbox), pak je **hromadně smazat** jedním tlačítkem (a později hromadně upravit). Staví na stabilním `Id` z Fáze 1.

**Architektura:** Čistá logika do `lib/bulk.js` (+ testy). Nový endpoint `POST /api/bulk-delete` (znovupoužije matching podle `Id` z `/delete-shift`, `index.js:2387`). Klientský JS: výběrový stav + plovoucí akční lišta v dashboard šabloně. CSRF jede přes globální wrapper z Fáze 1.

---

## Současný stav (ověřeno)
- `/delete-shift` (`index.js:2387`): ManualShifts maže řádek podle `Id` (fallback index řádku); Schedule listy jen z cache. Píše AuditLog `DELETE_SHIFT`, Slack, `notifyShiftChange`, `invalidateCache()`.
- Směny nesou `s._id` (Fáze 1, UUID v ManualShifts). Schedule směny `_id` nemají → mazat nelze (jen cache).
- Pilulky už předávají `_id` do `openViewModal` (Fáze 1).

## Návrh

### lib/bulk.js (čisté, testovatelné)
- `partitionSelection(items)` → `{ manual:[{id,name}], scheduleOnly:[{name,sheetTitle}], invalid:[] }`. ManualShifts položky musí mít neprázdné `id`; ostatní jdou do `scheduleOnly` (smazatelné jen z cache) nebo `invalid`.
- `dedupeIds(ids)` → unikátní neprázdné stringy.
- Testy `scripts/test-bulk.js`: prázdný vstup, mix manual/schedule, duplicitní/ prázdné id.

### Endpoint `POST /api/bulk-delete`
- Auth (`if(!req.user) 401`), CSRF (globální). Body: `{ items: [{ id, sheetTitle, name }] }`.
- `validateNoTemplateChars` na všech `name`. Limit počtu (např. max 200) → jinak 400.
- ManualShifts: načti `getRows()` **jednou**, smaž všechny řádky, jejichž `Id ∈ ids` (jeden průchod, ne N× getRows kvůli rychlosti/rate-limitu). Schedule položky: smaž z `_shiftsCache` (jako single delete).
- Jeden souhrnný AuditLog `BULK_DELETE_SHIFT|count=N|by=...` + (volitelně) per-shift, `invalidateCache()`, jeden Slack souhrn.
- Návrat `{ deleted:N, failed:[...] }`.

### Klient (dashboard šablona)
- Výběrový stav `Set` ids. **Ctrl/Cmd-klik** na pilulku přepne výběr (vizuální outline); bez Ctrl = stávající chování (otevři modal).
- Plovoucí lišta dole: „N vybráno — 🗑 Smazat / Zrušit výběr". Smazat → `confirm()` → `fetch('/api/bulk-delete', …)` (CSRF wrapper přidá token) → refresh.
- **POZOR (CLAUDE.md):** žádný backtick / `${` v JS bloku; data jen přes textContent / escapované atributy. Po změně `node -c` + ověřit konzoli.

## Verifikace
1. `node scripts/test-bulk.js` (pure logika).
2. `node -c index.js`; dashboard se vyrenderuje (200) + lišta v HTML (auth-bypass fetch).
3. Endpoint guardy: 401 bez session, 403 bez CSRF, 400 prázdné/přes limit.
4. **Řízený ostrý test:** vytvoř 2–3 testovací směny („ZZ_TEST_…"), vyber 2, bulk-delete → ověř že zmizely **právě ty 2** a zbytek (i ostatní směny) zůstal; uklid 3. (Dělat opatrně, ideálně s Davidem.)
5. **Browser test (David):** Ctrl-výběr, lišta, smazání, refresh.

## Rizika
- **Destruktivní** → confirm dialog, audit, limit počtu, jen ManualShifts se reálně mažou (Schedule cache-only jako dnes).
- Rate-limit Sheets → jeden `getRows()` + dávkové mazání, jeden audit/slack souhrn.
- Šablona dashboardu (nejkřehčí část) → striktně bez backticků/`${`, `node -c` po každé změně.

## Mimo rozsah (další iterace)
- **Hromadná úprava** (změna produktu/času pro N směn) — složitější UI; samostatně po bulk-delete.
