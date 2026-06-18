// Unit testy pro lib/stats.js (Fáze 6). Spuštění: node scripts/test-stats.js
const assert = require('assert');
const { buildTradingBreakdown, slotOfStart, buildCoverage } = require('../lib/stats');

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

// 7) slotOfStart — pokrývá reálné productMapping start časy
assert.strictEqual(slotOfStart('22:55'), 0);
assert.strictEqual(slotOfStart('00:04'), 0);
assert.strictEqual(slotOfStart('06:55'), 1);
assert.strictEqual(slotOfStart('08:04'), 1);
assert.strictEqual(slotOfStart('14:40'), 2);
assert.strictEqual(slotOfStart('16:04'), 2);
assert.strictEqual(slotOfStart('xx'), -1);
ok('slotOfStart: noční/ranní/odpolední dle start hodiny');

// 8) buildCoverage — expected/covered/gaps dle profilů (2026-06-01 = Po, 06-02 = Út)
const profiles = [
    { name: 'CS 2 Duels',     slots: [0, 1, 2], days: 'all' },
    { name: 'World of Tanks', slots: [1],       days: 'weekdays' }
];
const periodDates = ['2026-06-01', '2026-06-02'];
const covShifts = [
    { Product: 'CS 2 Duels',     Start: '00:00', Date: '2026-06-01' }, // noční
    { Product: 'CS 2 Duels',     Start: '08:00', Date: '2026-06-01' }, // ranní
    { Product: 'World of Tanks', Start: '07:30', Date: '2026-06-01' }  // ranní
];
const cov = buildCoverage(covShifts, profiles, periodDates);
const duels = cov.products.find(p => p.product === 'CS 2 Duels');
assert.strictEqual(duels.expected, 6);                 // 3 sloty * 2 dny
assert.strictEqual(duels.covered, 2);                  // noční+ranní den1
assert.strictEqual(duels.gaps, 4);
assert.deepStrictEqual(duels.gapDates, ['2026-06-01', '2026-06-02']); // den1 chybí odpolední, den2 nic
const tanks = cov.products.find(p => p.product === 'World of Tanks');
assert.strictEqual(tanks.expected, 2);                 // slot1 ve 2 všední dny
assert.strictEqual(tanks.covered, 1);
assert.deepStrictEqual(tanks.gapDates, ['2026-06-02']);
assert.strictEqual(cov.totalExpected, 8);
assert.strictEqual(cov.totalCovered, 3);
assert.strictEqual(cov.products[0].product, 'CS 2 Duels'); // nejhorší pct první (33 % < 50 %)
ok('buildCoverage: expected/covered/gaps + worst-first sort');

// 9) weekdays profil ignoruje víkend (2026-06-06 = So, 06-07 = Ne)
const we = buildCoverage([], [{ name: 'X', slots: [1], days: 'weekdays' }], ['2026-06-06', '2026-06-07']);
assert.strictEqual(we.products[0].expected, 0);
assert.strictEqual(we.pct, 100); // nic očekáváno => 100 %
ok('weekdays profil vyloučí víkendová data');

console.log('\nVSECHNY TESTY OK (' + n + ')');
