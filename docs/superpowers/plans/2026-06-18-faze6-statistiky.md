# Fáze 6A — Statistiky: Trading rozpad: Implementation Plan

**Goal:** Na `/stats` přidat **Trading breakdown** (hodiny + směny dle trading kategorie a produktu) v team overview i v detailu osoby, postavené na čisté testované funkci `lib/stats.js`. Bez dotyku hlavního dashboardu.

**Architecture:** Čistá agregace `buildTradingBreakdown` v `lib/stats.js` (vzor `lib/people.js`). V `index.js` jen import + dva render/helper kousky uvnitř `/stats` route. Názvy z dat se escapují (`tclean`) kvůli `${mainHTML}` template literalu.

**Tech Stack:** Node.js, vestavěný `assert`. Žádná nová npm závislost.

Spec: [docs/superpowers/specs/2026-06-18-faze6-statistiky-design.md](../specs/2026-06-18-faze6-statistiky-design.md)

---

## Poznámka k testování
Pravé unit testy pro čistou logiku (`lib/stats.js`). `/stats` integrace: `node -c index.js` + boot + vizuální kontrola (potřebuje login + data). Na Windows před restartem: `taskkill /F /IM node.exe`.

---

## Task 1: `lib/stats.js` + testy  ✅ HOTOVO
- [x] `buildTradingBreakdown(shifts, durationFn, opts)` — čistá agregace.
- [x] `scripts/test-stats.js` — 6 testů (seskupení, řazení, exclude, Other/(none), odolnost).
- [x] `node scripts/test-stats.js` → `VSECHNY TESTY OK (6)`.
- Commit: `feat(stats): pure trading-breakdown aggregation + tests`

---

## Task 2: Import + helpery v `/stats`

- [ ] **Step 1: Import** — k ostatním `require('./lib/...')` přidej:
```js
const { buildTradingBreakdown } = require('./lib/stats');
```

- [ ] **Step 2: Helpery uvnitř `/stats` route** — v `try` bloku, po definici `allShifts` a před `buildShiftList` (kolem `:2693`), vlož:
```js
        const tclean = (v) => String(v == null ? '' : v).replace(/`/g, "'").replace(/\$\{/g, '$ {').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const TRADING_PALETTE = ['#60a5fa','#f59e0b','#a78bfa','#34d399','#f472b6','#22d3ee','#fb7185','#facc15','#4ade80','#38bdf8','#fdba74','#c084fc'];
        const shiftsInRange = (rs, re) => allShifts.filter(s => { const d = new Date(s.Date); return d >= rs && d <= re; });
        function renderTradingPanel(rangeShifts, title, periodLabel) {
            const bd = buildTradingBreakdown(rangeShifts, calculateDuration, { excludeProducts: ['RIP', 'Vacation'] });
            if (!bd.categories.length) {
                return '<div class="panel"><div class="panel-header"><div class="panel-title">' + title + '</div><div class="panel-sub">' + periodLabel + '</div></div><div style="padding:26px;text-align:center;color:#4a5060;font-size:0.82rem;font-family:Oswald;letter-spacing:1px;">NO TRADING SHIFTS</div></div>';
            }
            const maxH = Math.max(1, ...bd.categories.map(c => c.hours));
            let rows = '';
            bd.categories.forEach((c, i) => {
                const col = TRADING_PALETTE[i % TRADING_PALETTE.length];
                const barPct = (c.hours / maxH) * 100;
                rows += '<div style="margin-bottom:12px;"><div style="display:flex;align-items:center;gap:10px;">'
                    + '<span style="width:10px;height:10px;border-radius:2px;background:' + col + ';flex-shrink:0;"></span>'
                    + '<span style="flex:1;font-weight:600;color:#dfe6f2;">' + tclean(c.trading) + '</span>'
                    + '<span style="color:#aab4c8;font-size:0.82rem;">' + c.hours.toFixed(1) + 'h &middot; ' + c.shifts + ' shifts</span></div>'
                    + '<div style="height:8px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden;margin-top:5px;"><div style="height:100%;width:' + barPct.toFixed(1) + '%;background:linear-gradient(90deg,' + col + ',' + col + '99);border-radius:5px;"></div></div>';
                if (c.products.length > 1) {
                    rows += '<div style="margin:7px 0 2px 20px;display:flex;flex-wrap:wrap;gap:6px;">';
                    c.products.forEach(p => { rows += '<span style="font-size:0.72rem;color:#8a94a8;background:rgba(255,255,255,0.04);border-radius:4px;padding:2px 8px;">' + tclean(p.product) + ' <b style="color:#c8d0e0;">' + p.hours.toFixed(1) + 'h</b></span>'; });
                    rows += '</div>';
                }
                rows += '</div>';
            });
            return '<div class="panel"><div class="panel-header"><div class="panel-title">' + title + '</div><div class="panel-sub">' + bd.categories.length + ' categories &middot; ' + bd.totalHours.toFixed(1) + 'h &middot; ' + bd.totalShifts + ' shifts</div></div><div style="padding:6px 2px;">' + rows + '</div></div>';
        }
```

- [ ] **Step 3:** `node -c index.js` (musí projít).

---

## Task 3: Zapojit panely

- [ ] **Step 1: Detail osoby (MONTH)** — v person-detail větvi, za panel „ALL SHIFTS THIS MONTH" (`:2873`) přidej:
```js
            mainHTML += renderTradingPanel(monthShifts, 'TRADING BREAKDOWN', monthLabel);
```

- [ ] **Step 2: Team overview (MONTH)** — za `mainHTML += renderTeamSection('MONTH', monthLabel, monthMap);` (`:2925`) přidej:
```js
            mainHTML += renderTradingPanel(shiftsInRange(monthStart, monthEnd), 'TEAM TRADING BREAKDOWN', monthLabel);
```

- [ ] **Step 3:** `node -c index.js`; `taskkill /F /IM node.exe`; `node index.js`; otevři `/stats` jako přihlášený → panel(y) se zobrazí, součty sedí, žádná chyba v konzoli.

- [ ] **Step 4: Commit**
```
git add index.js docs/
git commit -m "feat(stats): trading breakdown panels in /stats (team + person)"
```

---

## Self-Review
- **Pokrytí specu:** §4.1 → Task 1; §4.2 → Task 2+3; §4.3 (tclean) → Task 2. Vše pokryto.
- **Konzistence:** `buildTradingBreakdown(shifts, calculateDuration, {excludeProducts})` shodně v helperu; `renderTradingPanel` volán s polem směn (person: `monthShifts`; team: `shiftsInRange(...)`).
- **Bezpečnost:** všechny názvy z dat přes `tclean`.
- **Otevřené:** 6B coverage — samostatně.
