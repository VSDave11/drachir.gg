# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
node index.js
```

Runs on `http://localhost:3000`. No build step, no tests, no linter. The app deploys to Render.com — the `GOOGLE_CREDENTIALS` env var is used in production instead of `credentials.json`.

**Env vars.** Core dashboard needs only Google creds. Extra features read additional vars and silently no-op (or return 503) when absent:
- `ANTHROPIC_API_KEY` — required by the AI schedule generator (`/api/generate-schedule`).
- `SLACK_WEBHOOK_URL` / `SLACK_BOT_TOKEN` — Slack shift notifications.
- `BAMBOOHR_API_KEY` / `BAMBOOHR_SUBDOMAIN` — vacation/absence sync.

## Architecture

The Express server is one large file: **`index.js`** (~6100 lines — it has roughly doubled since this doc was first written, mostly from the schedule-generator work). It serves a single-page HTML dashboard. There is no frontend framework — all HTML, CSS, and client JS are generated as template strings inside route handlers and sent via `res.send()`.

**`public/`** — Static assets (login page `index.html`, `style.css`, images). The login page is served at `/`, the dashboard at `/dashboard`.

**Repo layout beyond the server:**
- **`criteria.md`** — source-of-truth business rules for the AI generator (people, products, hard/soft constraints H1–H11, per-person preferences). Read at generate time, no redeploy needed.
- **`lib/local-solver.js`** — deterministic candidate-scoring solver (enforces no-night groups, weekly shift caps, eligibility).
- **`scripts/`** — CLI tools: `batch-local-solver.js`, `commit-to-schedule.js`, `generate-live.js`, `preview-prompt*.js`, plus `test-*` checks. No test runner; run with `node scripts/<file>.js`.
- **`outputs/`** — generated schedules/prompts (gitignored; regenerable, the app never reads them).

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
| `POST /api/generate-schedule` | AI generator — builds a month's shifts via Claude + hard-constraint validator (needs `ANTHROPIC_API_KEY`) |
| `GET /api/generate-preview` | Returns the generator prompt + resolved inputs (vacations, eligibility) without calling Claude |
| `POST /api/commit-to-schedule` | Writes generated/approved shifts back into Google Sheets |
| `GET /api/capabilities` | Per-product eligibility list (from `Capabilities` sheet) |
| `POST /api/bamboo-sync` | Pulls vacation/absence data from BambooHR |
| `GET` / `POST /api/slack-subscriptions` | Read/update Slack notification subscriptions |
| `GET /api/custom-colors`, `POST /api/set-color`, `POST /api/reset-colors` | Per-user color overrides |
| `GET /stats` | Stats/analytics page |
| `GET` / `POST /change-password` | Change a user's password |
| `GET /debug-schedule` | Debug dump of parsed schedule data |

### AI schedule generator

A subsystem that proposes a full month of shifts, then writes the approved result back to Sheets.

- **Rules** live in `criteria.md` (business rules, read fresh on every generate — no redeploy) plus hard-coded technical constraints in `index.js` / the validator (H1–H8: coverage, eligibility, vacation, handover gaps, max consecutive days, one-product-per-day). `criteria.md` adds H9–H11 (no-night groups, strict weekly shift caps, Europe-nights-allowed) and soft rules S1–S6.
- **Two generation paths:** (1) `POST /api/generate-schedule` calls Claude with `buildGeneratorPrompt` output and forces structured JSON, then runs the hard-constraint validator; (2) `lib/local-solver.js` is a deterministic, offline solver (no API cost) driven from `scripts/batch-local-solver.js`.
- **Preview before spend:** `GET /api/generate-preview` (and `scripts/preview-prompt*.js`) returns the assembled prompt + resolved inputs (vacations, eligibility) so you can inspect token size and inputs without paying for a Claude call.
- **Commit:** approved shifts go back to Sheets via `POST /api/commit-to-schedule` (or `scripts/commit-to-schedule.js --commit`).
- **Integrations feeding it:** BambooHR (`/api/bamboo-sync`) supplies vacations; the `Capabilities` sheet supplies per-product eligibility; Slack pushes notifications.

### Client JS (embedded in dashboard template)

Serialized at render time: `pColors` (person colors), `pRoles` (person→group), `tColors` (trading category colors), `pColorsProduct` (per-product colors).

Key client functions: `openViewModal()`, `applyAllFilters()`, `toggleSelect()`, `toggleProduct()`, `saveSelection()` (persists sidebar state to `localStorage` keys `ygg_sel_names` / `ygg_sel_prods`).

### Debugging tips

- To verify client JS is valid: fetch the rendered HTML, extract `<script>` content, run `node -c` on it.
- Auth bypass for local testing: change the dashboard auth check to `if (!req.session.user) { req.session.user = {jmeno:'Debug',email:'x',role:'Admin',location:''}; }` and also set `saveUninitialized: true` in session config. **Revert both before committing.**
