// Unit testy pro lib/bulk.js (Fáze 5). Spuštění: node scripts/test-bulk.js
const assert = require('assert');
const { dedupeIds, partitionSelection } = require('../lib/bulk');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// dedupeIds
assert.deepStrictEqual(dedupeIds(['a', 'b', 'a', '', null, ' c ', 'b']), ['a', 'b', 'c']);
ok('dedupeIds: unikátní, trim, bez prázdných/null');
assert.deepStrictEqual(dedupeIds(null), []);
ok('dedupeIds: null => []');

// partitionSelection
const r = partitionSelection([
    { id: 'u1', sheetTitle: 'ManualShifts', name: 'Jan' },
    { id: '',   sheetTitle: 'ManualShifts', name: 'NoId' },        // manual bez id => invalid
    { id: 'x',  sheetTitle: 'Schedule - June 2026', name: 'Eva' }, // schedule => cache-only
    { sheetTitle: '', name: 'Nic' },                                // bez sheetu => invalid
    null
]);
assert.deepStrictEqual(r.manual, [{ id: 'u1', name: 'Jan' }]);
ok('partition: ManualShifts s id => manual');
assert.deepStrictEqual(r.scheduleOnly, [{ sheetTitle: 'Schedule - June 2026', name: 'Eva' }]);
ok('partition: Schedule => scheduleOnly (cache)');
assert.strictEqual(r.invalid.length, 3); // NoId, Nic, null
ok('partition: ManualShifts bez id / bez sheetu / null => invalid');

assert.deepStrictEqual(partitionSelection(null), { manual: [], scheduleOnly: [], invalid: [] });
ok('partition: null => prázdné kolekce');

console.log('\nVSECHNY TESTY OK (' + n + ')');
