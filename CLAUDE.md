# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
node index.js
```

Runs on `http://localhost:3000`. No build step, no tests, no linter. The app deploys to Render.com — the `GOOGLE_CREDENTIALS` env var is used in production instead of `credentials.json`.

## Architecture

Everything lives in a single file: **`index.js`** (~2700 lines). It is a Node.js/Express server that serves a single-page HTML dashboard. There is no frontend framework — all HTML, CSS, and client JS are generated as template strings inside route handlers and sent via `res.send()`.

**`public/`** — Static assets (login page `index.html`, `style.css`, images). The login page is served at `/`, the dashboard at `/dashboard`.

### Critical: Template literal safety

The entire dashboard HTML is inside one ES6 template literal (`res.send(\`...\`)`). Any data interpolated via `${...}` that contains a backtick will **break the entire page with no visible error** — the server sends malformed HTML and all client JS fails silently. The `safe()` helper only strips quotes, not backticks. Always validate that data from Google Sheets cannot contain backticks or `${` sequences.

When adding client-side JS inside the template: use `\${...}` for server-side interpolation and be careful not to accidentally create nested template literals.

### Critical: Multiple node processes

On Windows, `node index.js` may leave orphaned processes on port 3000. Always `taskkill //F //IM node.exe` before restarting, or the browser will hit a stale server serving old code. This is the #1 cause of "nothing works after my edit" confusion.

### Data layer

Google Sheets is the database. The `google-spreadsheet` + `google-auth-library` (JWT) packages read/write sheets.

- **`Schedule - <Month Year>`** sheets (e.g. `Schedule - March 2026`) — shift planner grid. Columns map to products via `productMapping` (hardcoded column offsets, e.g. Valhalla Cup A starts at col 2). Dates are in column 0 as Google Sheets serial numbers or Czech-format strings (`6.4.2026`).
- **`ManualShifts`** sheet — manually added/edited shifts, with columns `Date, Name, Trading, Product, Start, End, Note`.
- **`AuditLog`** sheet — event log with columns `Timestamp, Jmeno, Event, Detail`. Events: `LOGIN`, `ADD_SHIFT|name|product|date`, `EDIT_SHIFT|name|product|date`.
- **`uzivatele`** sheet — user accounts (email, password, role, jmeno, location).

**Cache:** `_shiftsCache` + `_shiftsCacheTime` — 2-minute in-memory cache for all shifts. Invalidated by any write operation. The `/dashboard?sync=1` query forces a refresh.

### Key server-side functions (module-level)

- `convertCzechDate(val)` — normalises any date format (serial number, `D.M.YYYY`, ISO) to `YYYY-MM-DD`.
- `timeToPercent(timeStr)` — converts `HH:MM` → 0–100% of 24 hours.
- `calculateDuration(start, end)` — returns shift duration in hours, handles overnight.
- `getProductColor(tradingName, productName)` — returns per-product color from `productColors`, falls back to category color from `tradingHierarchy`.
- `safe(str)` — strips single/double quotes from strings for safe embedding in onclick attributes.

### Dashboard rendering (`GET /dashboard`)

The entire page is built server-side in one large template literal. Key data structures declared inside the route:

- `peopleHierarchy` — groups of people with display color and weekly target hours.
- `tradingHierarchy` — trading categories with sub-products (e.g. FIFA → Valhalla Cup A/B/C).
- `productColors` — per-product hex colors (defined at module level).
- `personColors` — per-person hex colors (~58 entries, defined at module level).

**Views** — controlled by `?view=` query param:
- `timeline` (default) — horizontal 7-day scrollable grid. Each person/product is a row (`user-row` / `product-row`). Shifts are `position:absolute` pills with `left`/`width` as percentages of the 6720px-wide grid (960px/day = 40px/hour).
- `week` — vertical calendar grid, 7 columns × 24 rows (40px/hour).
- `list` — flat chronological list grouped by day.
- `agenda` — Google Calendar-style with date sidebar.

**Pill rendering** — `buildPersonPill()` and `buildProdPill()` generate shift pill HTML. Timeline pills use diagonal gradient backgrounds (person + product colors). The `.shift-pill` CSS class provides base styling; inline styles set position/size/colors.

**Overnight shifts** — detected when `startPct > endPct && endPct > 0`. Rendered as two pills: Pill 1 (start → midnight), Pill 2 (midnight → end, next day). A pre-pass loop handles Sunday→Monday continuation for shifts that started the previous week.

**Sidebar filter** — `applyAllFilters()` in client JS shows/hides rows by toggling `hidden-row` CSS class. A pre-filter `<script>` in `<head>` immediately hides all rows if localStorage has saved selections (prevents flash of unfiltered content). This style is removed after `window.onload` applies the real filters. **If any JS error occurs before `window.onload`, all rows stay hidden** — this looks like "the calendar disappeared."

### API endpoints

| Route | Purpose |
|-------|---------|
| `POST /login` | Auth against `uzivatele` sheet |
| `GET /export-csv` | Download all shifts as CSV (Admin/TL only), supports `?name=` filter |
| `POST /add-shift` | Adds row to `ManualShifts` |
| `POST /update-shift` | Edits row in `ManualShifts` by row index |
| `POST /delete-shift` | Deletes row from `ManualShifts` |
| `POST /exchange-shift` | Swaps two people's shifts |
| `POST /delete-month` | Clears all ManualShifts for a given month |
| `GET /api/shift-history` | Returns created/edited audit entries for a specific shift |
| `GET /api/schedule-sheets` | Returns sorted list of `Schedule - *` sheet names |

### Client JS (embedded in dashboard template)

Serialized at render time: `pColors` (person colors), `pRoles` (person→group), `tColors` (trading category colors), `pColorsProduct` (per-product colors).

Key client functions: `openViewModal()`, `applyAllFilters()`, `toggleSelect()`, `toggleProduct()`, `saveSelection()` (persists sidebar state to `localStorage` keys `ygg_sel_names` / `ygg_sel_prods`).

### Debugging tips

- To verify client JS is valid: fetch the rendered HTML, extract `<script>` content, run `node -c` on it.
- Auth bypass for local testing: change the dashboard auth check to `if (!req.session.user) { req.session.user = {jmeno:'Debug',email:'x',role:'Admin',location:''}; }` and also set `saveUninitialized: true` in session config. **Revert both before committing.**
