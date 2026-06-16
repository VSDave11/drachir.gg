const assert = require('assert');
const { validateNoTemplateChars } = require('../lib/validate');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// 1) čisté hodnoty projdou
assert.strictEqual(validateNoTemplateChars('Jan Novak', 'Poznamka'), null);
ok('čisté hodnoty => null');

// 2) zpětná uvozovka => chyba
assert.notStrictEqual(validateNoTemplateChars('a`b'), null);
ok('backtick => chyba');

// 3) ${ sekvence => chyba
assert.notStrictEqual(validateNoTemplateChars('x${y}'), null);
ok('${ => chyba');

// 4) ignoruje null/undefined/čísla
assert.strictEqual(validateNoTemplateChars(null, undefined, 42, 'ok'), null);
ok('null/undefined/číslo bezpečně ignorováno');

console.log('\nVŠECHNY TESTY OK (' + n + ')');
