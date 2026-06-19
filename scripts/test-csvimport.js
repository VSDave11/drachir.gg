const assert = require('assert');
const { parseShiftsCsv } = require('../lib/csvimport');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };
const nd = (d) => { // mock normalizeDate: D.M.YYYY -> YYYY-MM-DD, jinak vrať jak je
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(d).trim());
    if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    return d;
};

// 1) základní parse (čárka) + valid řádek
let r = parseShiftsCsv('Date,Name,Trading,Product,Start,End,Note\n2026-06-20,Alice,FIFA,Valhalla Cup A,08:00,16:00,x', { normalizeDate: nd });
assert.strictEqual(r.headerError, null);
assert.strictEqual(r.validCount, 1);
assert.deepStrictEqual(r.rows[0], { Date: '2026-06-20', Name: 'Alice', Trading: 'FIFA', Product: 'Valhalla Cup A', Start: '08:00', End: '16:00', Note: 'x', valid: true, error: null });
ok('parse čárkou, validní řádek');

// 2) středník jako oddělovač + české hlavičky + normalizace data
r = parseShiftsCsv('Datum;Jmeno;Produkt;Od;Do\n20.6.2026;Bob;CS 2 Duels;08:00;16:00', { normalizeDate: nd });
assert.strictEqual(r.headerError, null);
assert.strictEqual(r.validCount, 1);
assert.strictEqual(r.rows[0].Date, '2026-06-20');
assert.strictEqual(r.rows[0].Name, 'Bob');
ok('středník + české hlavičky + normalizace D.M.YYYY');

// 3) chybné řádky: špatné datum, čas, chybějící jméno/produkt
r = parseShiftsCsv('Date,Name,Product,Start,End\nxx,Alice,P,08:00,16:00\n2026-06-20,,P,08:00,16:00\n2026-06-20,Bob,P,8h,16:00\n2026-06-20,Carol,,08:00,16:00', { normalizeDate: nd });
assert.strictEqual(r.validCount, 0);
assert.strictEqual(r.errorCount, 4);
assert.ok(r.rows[0].error.includes('datum'));
assert.ok(r.rows[1].error.includes('jméno'));
assert.ok(r.rows[2].error.includes('čas'));
assert.ok(r.rows[3].error.includes('produkt'));
ok('chybné řádky: datum/jméno/čas/produkt');

// 4) template-literal guard
r = parseShiftsCsv('Date,Name,Product,Start,End\n2026-06-20,Ev`il,P,08:00,16:00', { normalizeDate: nd });
assert.strictEqual(r.validCount, 0);
assert.ok(r.rows[0].error.includes('znak'));
ok('zakázaný znak v jméně');

// 5) chybějící povinné sloupce
r = parseShiftsCsv('Foo,Bar\n1,2', { normalizeDate: nd });
assert.ok(r.headerError && r.headerError.includes('povinné'));
ok('chybí povinné sloupce -> headerError');

// 6) prázdný vstup
r = parseShiftsCsv('', { normalizeDate: nd });
assert.ok(r.headerError);
ok('prázdný vstup -> headerError');

console.log('\nVSECHNY TESTY OK (' + n + ')');
