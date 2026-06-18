# Fáze 4 — Per-uživatel řazení řádků: Spec + Plán (ready-to-implement)

> **Stav:** návrh připraven k implementaci. Odloženo na chvíli s prohlížečem — feature je **interaktivní** (drag / klik přesouvá řádky), což nejde autonomně ověřit (nemůžu klikat v prohlížeči). Pure logika + render se otestují; samotné přesouvání ověří David v prohlížeči. Není destruktivní (jen `localStorage`), produkční riziko = jen křehkost dashboard šablony → mitigováno `node -c` + ověřením renderu.

**Goal:** Každý uživatel si může přerovnat pořadí řádků (lidí / produktů) v timeline view; pořadí se uloží do `localStorage` a aplikuje při načtení. Konzistentní se stávajícím per-browser personalizačním vzorem (`ygg_sel_*`, `ygg_grp_collapse`, `ygg_view`, `ygg_tz`).

**Architektura:** Čistá řadicí logika do `lib/ordering.js` (+ testy). Klientský JS v dashboard šabloně: UI pro změnu pořadí + uložení + aplikace při `onload`. Žádná serverová ani Sheets změna.

---

## Současný stav (ověřeno)
- Timeline view: řádky `.timeline-row.user-row[data-name="…"]` a `.product-row[data-product-row="…"]` se renderují server-side v pevném pořadí (`peopleHierarchy` / `productMapping`).
- Filtrování: `applyAllFilters()` jen přepíná `hidden-row` (nemění pořadí). Skupiny se collapsují (`ygg_grp_collapse`).
- Týden/list/agenda nemají per-osobu řádky → řazení se týká **jen timeline view**.

## Návrh

### lib/ordering.js (čisté, testovatelné)
- `reorderBySaved(currentKeys, savedOrder)` → uložené pořadí první (jen klíče, co stále existují, bez duplicit), pak zbývající aktuální klíče v původním pořadí. Robustní vůči přidaným/odebraným lidem.
- `moveKey(order, key, dir)` → posun klíče o ±1 (pro tlačítka nahoru/dolů).
- Testy `scripts/test-ordering.js`: prázdné savedOrder = beze změny; odebraný klíč zmizí; nový klíč na konec; move na kraji nepřeteče.

### Klient (dashboard šablona)
- **Mechanismus (doporučeno: tlačítka ▲▼)** — robustnější a snáz ověřitelné než drag. V sidebar seznamu lidí/produktů přidat malá ▲▼ na řádek; klik zavolá `moveKey` + uloží `localStorage` (`ygg_order_names`, `ygg_order_prods`) + znovu aplikuje. (Alternativa: HTML5 drag — hezčí UX, křehčí.)
- **Aplikace při načtení:** `applyRowOrder()` — vezmi `data-name` všech `.timeline-row.user-row`, spočti `reorderBySaved`, a v jejich kontejneru je přeřaď (`appendChild` v novém pořadí). Totéž pro `.product-row` a pro sidebar položky. Volat v `window.onload` **po** stávajících filtrech (aby se nepralo s `hidden-row`).
- **POZOR (CLAUDE.md):** žádný backtick / `${` v JS bloku; po změně `node -c` + ověřit konzoli (chyba před `onload` = „kalendář zmizí").

## Verifikace
1. `node scripts/test-ordering.js` (pure logika).
2. `node -c index.js`; dashboard se vyrenderuje (200) + ▲▼ ovládání v HTML (auth-bypass fetch); extrahovaný klientský `<script>` projde `node -c`.
3. **Browser test (David):** přerovnat řádek, reload → pořadí drží; přidání/odebrání člověka (Fáze 3) pořadí nerozbije.

## Rizika
- Křehká dashboard šablona → striktně bez backticků/`${`, `node -c` + render check po každé změně.
- Souběh s `applyAllFilters` / collapse → `applyRowOrder` spustit po nich a jen přesouvat, ne měnit viditelnost.
- Konzistence napříč skupinami: rozhodnout, zda řazení je v rámci skupiny, nebo globální (doporučeno: v rámci skupiny, ať nerozbije group headery).
