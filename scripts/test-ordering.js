// Unit testy pro lib/ordering.js (Fáze 4). Spuštění: node scripts/test-ordering.js
const assert = require('assert');
const { reorderBySaved, moveKey } = require('../lib/ordering');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// reorderBySaved
assert.deepStrictEqual(reorderBySaved(['a', 'b', 'c'], []), ['a', 'b', 'c']);
ok('prázdné saved => beze změny');
assert.deepStrictEqual(reorderBySaved(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
ok('plné saved => přesné pořadí');
assert.deepStrictEqual(reorderBySaved(['a', 'b', 'c'], ['c']), ['c', 'a', 'b']);
ok('částečné saved => zbytek v původním pořadí za ním');
assert.deepStrictEqual(reorderBySaved(['a', 'b'], ['x', 'b', 'a']), ['b', 'a']);
ok('odebraný klíč v saved se ignoruje (x neexistuje)');
assert.deepStrictEqual(reorderBySaved(['a', 'b', 'c'], ['a', 'a', 'b']), ['a', 'b', 'c']);
ok('duplicity v saved se odstraní');
assert.deepStrictEqual(reorderBySaved([], ['a']), []);
ok('prázdné current => prázdné');

// moveKey
assert.deepStrictEqual(moveKey(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
ok('moveKey nahoru');
assert.deepStrictEqual(moveKey(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
ok('moveKey dolů');
assert.deepStrictEqual(moveKey(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
ok('moveKey na horním kraji = beze změny');
assert.deepStrictEqual(moveKey(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
ok('moveKey na dolním kraji = beze změny');
assert.deepStrictEqual(moveKey(['a', 'b'], 'x', -1), ['a', 'b']);
ok('moveKey neznámý klíč = beze změny');

console.log('\nVSECHNY TESTY OK (' + n + ')');
