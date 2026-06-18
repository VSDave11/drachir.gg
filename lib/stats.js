// Čistá agregační logika pro statistiky (Fáze 6). Bez I/O — testovatelné.

// Rozpad směn podle trading kategorie a produktu.
//   shifts: [{ Trading, Product, Start, End }]
//   durationFn: (start, end) => number (hodiny); když chybí, hodiny = 0
//   opts.excludeProducts: názvy produktů, které se nepočítají (např. 'RIP', 'Vacation')
// Vrací: { categories: [{ trading, hours, shifts, products:[{product, hours, shifts}] }], totalHours, totalShifts }
// Kategorie i produkty jsou seřazené sestupně podle hodin (tie-break dle názvu).
function buildTradingBreakdown(shifts, durationFn, opts) {
    opts = opts || {};
    const exclude = new Set((opts.excludeProducts || []).map(function (x) { return String(x); }));
    const dur = typeof durationFn === 'function' ? durationFn : function () { return 0; };
    const cats = {};
    let totalShifts = 0;

    (shifts || []).forEach(function (s) {
        if (!s) return;
        const product = (s.Product == null ? '' : String(s.Product)).trim();
        if (exclude.has(product)) return;
        const trading = ((s.Trading == null ? '' : String(s.Trading)).trim()) || 'Other';
        let hrs = dur(s.Start, s.End);
        if (typeof hrs !== 'number' || isNaN(hrs) || hrs < 0) hrs = 0;

        if (!cats[trading]) cats[trading] = { trading: trading, hours: 0, shifts: 0, _products: {} };
        const c = cats[trading];
        c.hours += hrs; c.shifts += 1;

        const pkey = product || '(none)';
        if (!c._products[pkey]) c._products[pkey] = { product: pkey, hours: 0, shifts: 0 };
        c._products[pkey].hours += hrs; c._products[pkey].shifts += 1;

        totalShifts += 1;
    });

    const round1 = function (n) { return Math.round(n * 10) / 10; };
    const categories = Object.keys(cats).map(function (k) {
        const c = cats[k];
        const products = Object.keys(c._products).map(function (pk) {
            const p = c._products[pk];
            return { product: p.product, hours: round1(p.hours), shifts: p.shifts };
        }).sort(function (a, b) { return b.hours - a.hours || a.product.localeCompare(b.product); });
        return { trading: c.trading, hours: round1(c.hours), shifts: c.shifts, products: products };
    }).sort(function (a, b) { return b.hours - a.hours || a.trading.localeCompare(b.trading); });

    // totalHours odvozené ze zaokrouhlených kategorií, aby hlavička vždy seděla se součtem zobrazených řádků
    const totalHours = round1(categories.reduce(function (a, c) { return a + c.hours; }, 0));
    return { categories: categories, totalHours: totalHours, totalShifts: totalShifts };
}

// Slot index ze startu "HH:MM": 0 = noční (>=22 nebo <6), 1 = ranní (6–13), 2 = odpolední (14–21).
// Pokrývá všechny start časy z productMapping (noční 22:40–00:04, ranní 06:40–08:04, odpolední 14:40–16:04).
function slotOfStart(startStr) {
    const h = parseInt(String(startStr == null ? '' : startStr).split(':')[0], 10);
    if (isNaN(h)) return -1;
    if (h >= 22 || h < 6) return 0;
    if (h < 14) return 1;
    return 2;
}

// Je dané datum ('YYYY-MM-DD') v coverage profilu? days: 'all' | 'weekdays' | 'weekends'.
function dateInCoverageDays(dateStr, daysType) {
    if (!daysType || daysType === 'all') return true;
    const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=Ne .. 6=So
    if (daysType === 'weekdays') return dow >= 1 && dow <= 5;
    if (daysType === 'weekends') return dow === 0 || dow === 6;
    return true;
}

// Pokrytí za období podle coverage profilů (criteria.md §2 / productCoverage).
//   shifts: [{ Product, Start, Date 'YYYY-MM-DD' }] (už v období, deduped)
//   productProfiles: [{ name, slots:[0,1,2], days:'all'|'weekdays'|'weekends' }]
//   periodDates: ['YYYY-MM-DD', ...] všechny dny období
// Vrací: { products:[{product, expected, covered, gaps, pct, gapDates:[...]}], totalExpected, totalCovered, pct }
// Slot (product,date,slot) je "covered", pokud existuje aspoň jedna směna toho produktu v ten den s daným slotem.
function buildCoverage(shifts, productProfiles, periodDates) {
    const have = {}; // product -> date -> { slot: true }
    (shifts || []).forEach(function (s) {
        if (!s) return;
        const p = (s.Product == null ? '' : String(s.Product)).trim();
        if (!p) return;
        const slot = slotOfStart(s.Start);
        if (slot < 0) return;
        const date = (s.Date == null ? '' : String(s.Date)).trim();
        if (!date) return;
        if (!have[p]) have[p] = {};
        if (!have[p][date]) have[p][date] = {};
        have[p][date][slot] = true;
    });

    let totalExpected = 0, totalCovered = 0;
    const products = (productProfiles || []).map(function (prof) {
        const slots = prof.slots || [0, 1, 2];
        const days = prof.days || 'all';
        let expected = 0, covered = 0;
        const gapDates = [];
        (periodDates || []).forEach(function (date) {
            if (!dateInCoverageDays(date, days)) return;
            let dayHasGap = false;
            slots.forEach(function (slot) {
                expected += 1;
                if (have[prof.name] && have[prof.name][date] && have[prof.name][date][slot]) covered += 1;
                else dayHasGap = true;
            });
            if (dayHasGap) gapDates.push(date);
        });
        totalExpected += expected; totalCovered += covered;
        return {
            product: prof.name,
            expected: expected,
            covered: covered,
            gaps: expected - covered,
            pct: expected > 0 ? Math.round((covered / expected) * 100) : 100,
            gapDates: gapDates
        };
    }).sort(function (a, b) { return a.pct - b.pct || b.gaps - a.gaps || a.product.localeCompare(b.product); });

    return {
        products: products,
        totalExpected: totalExpected,
        totalCovered: totalCovered,
        pct: totalExpected > 0 ? Math.round((totalCovered / totalExpected) * 100) : 100
    };
}

module.exports = { buildTradingBreakdown, slotOfStart, buildCoverage };
