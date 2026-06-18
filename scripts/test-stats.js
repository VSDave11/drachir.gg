// Unit testy pro lib/stats.js (Fáze 6). Spuštění: node scripts/test-stats.js
const assert = require('assert');
const { buildTradingBreakdown } = require('../lib/stats');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// pevná duration: každá směna 8h
const dur8 = () => 8;

// 1) prázdný vstup => prázdný rozpad
let r = buildTradingBreakdown([], dur8);
assert.deepStrictEqual(r, { categories: [], totalHours: 0, totalShifts: 0 });
ok('prázdný vstup => prázdný rozpad');

// 2) seskupení podle Trading + Product, řazení dle hodin
const shifts = [
    { Trading: 'FIFA', Product: 'Valhalla Cup A', Start: '07:00', End: '15:00' },
    { Trading: 'FIFA', Product: 'Valhalla Cup A', Start: '15:00', End: '23:00' },
    { Trading: 'FIFA', Product: 'Valkyrie Cup A', Start: '07:00', End: '15:00' },
    { Trading: 'NBA',  Product: 'Valhalla League', Start: '08:00', End: '16:00' }
];
r = buildTradingBreakdown(shifts, dur8);
assert.strictEqual(r.totalShifts, 4);
assert.strictEqual(r.totalHours, 32);
assert.strictEqual(r.categories.length, 2);
assert.strictEqual(r.categories[0].trading, 'FIFA');     // 24h => první
assert.strictEqual(r.categories[0].hours, 24);
assert.strictEqual(r.categories[0].shifts, 3);
assert.strictEqual(r.categories[0].products.length, 2);
assert.strictEqual(r.categories[0].products[0].product, 'Valhalla Cup A'); // 16h => první
assert.strictEqual(r.categories[0].products[0].hours, 16);
assert.strictEqual(r.categories[0].products[0].shifts, 2);
assert.strictEqual(r.categories[1].trading, 'NBA');
ok('seskupení podle Trading + Product, řazení dle hodin');

// 3) exclude RIP/Vacation
const shifts2 = [
    { Trading: 'FIFA', Product: 'Valhalla Cup A', Start: '07:00', End: '15:00' },
    { Trading: '', Product: 'RIP', Start: '07:00', End: '15:00' },
    { Trading: '', Product: 'Vacation', Start: '07:00', End: '15:00' }
];
r = buildTradingBreakdown(shifts2, dur8, { excludeProducts: ['RIP', 'Vacation'] });
assert.strictEqual(r.totalShifts, 1);
assert.strictEqual(r.categories.length, 1);
assert.strictEqual(r.categories[0].trading, 'FIFA');
ok('RIP/Vacation se vyloučí přes excludeProducts');

// 4) chybějící Trading => 'Other'; reálná duration fn (i přes půlnoc)
const dur = (s, e) => {
    const a = s.split(':').map(Number), b = e.split(':').map(Number);
    let d = (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]);
    if (d < 0) d += 24 * 60;
    return d / 60;
};
const shifts3 = [{ Product: 'Mystery', Start: '07:00', End: '15:30' }]; // 8.5h, bez Trading
r = buildTradingBreakdown(shifts3, dur);
assert.strictEqual(r.categories[0].trading, 'Other');
assert.strictEqual(r.categories[0].hours, 8.5);
assert.strictEqual(r.categories[0].products[0].product, 'Mystery');
ok('chybějící Trading => Other; reálná duration včetně přes půlnoc');

// 5) odolnost: null prvek přeskočen, NaN/záporná duration => 0
r = buildTradingBreakdown([null, { Trading: 'X', Product: 'P', Start: 'a', End: 'b' }], () => NaN);
assert.strictEqual(r.totalShifts, 1);
assert.strictEqual(r.totalHours, 0);
assert.strictEqual(r.categories[0].hours, 0);
ok('null prvek přeskočen, NaN duration => 0');

// 6) produkt bez názvu => '(none)'
r = buildTradingBreakdown([{ Trading: 'Duels', Product: '', Start: '08:00', End: '16:00' }], dur8);
assert.strictEqual(r.categories[0].products[0].product, '(none)');
ok('prázdný produkt => (none)');

console.log('\nVSECHNY TESTY OK (' + n + ')');
