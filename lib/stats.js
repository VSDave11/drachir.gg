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

module.exports = { buildTradingBreakdown };
