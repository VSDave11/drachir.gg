const assert = require('assert');
const { hashPassword, verifyPassword } = require('../lib/auth');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// 1) hash má očekávaný formát scrypt$salt$hash
const h = hashPassword('TajneHeslo123');
assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, 'formát hashe');
ok('hashPassword vrací scrypt$salt$hash');

// 2) stejné heslo dvakrát => různý hash (kvůli soli)
assert.notStrictEqual(h, hashPassword('TajneHeslo123'), 'sůl se liší');
ok('dva hashe stejného hesla se liší');

// 3) verify správného hesla proti hashi
let r = verifyPassword('TajneHeslo123', h);
assert.strictEqual(r.ok, true);  assert.strictEqual(r.legacy, false);
ok('verify správného hesla proti hashi');

// 4) verify špatného hesla proti hashi
r = verifyPassword('Spatne', h);
assert.strictEqual(r.ok, false);
ok('verify špatného hesla selže');

// 5) legacy plaintext — shoda
r = verifyPassword('plain', 'plain');
assert.strictEqual(r.ok, true);  assert.strictEqual(r.legacy, true);
ok('legacy plaintext shoda => ok+legacy');

// 6) legacy plaintext — neshoda
r = verifyPassword('plain', 'jine');
assert.strictEqual(r.ok, false);
ok('legacy plaintext neshoda => false');

console.log('\nVŠECHNY TESTY OK (' + n + ')');
