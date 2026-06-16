// scripts/test-validator.js
// Sanity test pro nove validacni rules H7 + H8.
// Vyrobime umyslne 3 typy poruseni a ocekavame ze validator je nahlasi.

const { validateGeneratedSchedule, peopleHierarchy } = require('..');

const product = 'Valhalla Cup A';

// Minimalistic capabilities (jen co je potreba pro test)
const caps = {
    products: ['Valhalla Cup A'],
    byProduct: { 'Valhalla Cup A': ['Lukáš Novotný', 'Adam Zach', 'Denis M.'] },
    byPerson: {
        'Lukáš Novotný': ['Valhalla Cup A'],
        'Adam Zach': ['Valhalla Cup A'],
        'Denis M.': ['Valhalla Cup A']
    },
    personMeta: {}
};
peopleHierarchy.forEach(g => g.members.forEach(m => {
    if (caps.byPerson[m]) caps.personMeta[m] = { group: g.label, weeklyTarget: g.target, color: g.color };
}));

// Test scenarios — kazdy je umyslne porusene
const scenarios = [
    {
        name: 'H4 — morning + night same day (stary)',
        shifts: [
            { date: '2026-06-01', slotIndex: 1, person: 'Lukáš Novotný' },  // morning
            { date: '2026-06-01', slotIndex: 0, person: 'Lukáš Novotný' },  // night SAME DAY
        ],
        expectCode: 'MORNING_NIGHT_SAME_DAY'
    },
    {
        name: 'H8 — afternoon + night same day (novy)',
        shifts: [
            { date: '2026-06-02', slotIndex: 2, person: 'Adam Zach' },      // afternoon
            { date: '2026-06-02', slotIndex: 0, person: 'Adam Zach' },      // night SAME DAY
        ],
        expectCode: 'AFTERNOON_NIGHT_SAME_DAY'
    },
    {
        name: 'H7 — night den X + morning den X+1 (novy)',
        shifts: [
            { date: '2026-06-03', slotIndex: 0, person: 'Denis M.' },       // night
            { date: '2026-06-04', slotIndex: 1, person: 'Denis M.' },       // morning NEXT DAY
        ],
        expectCode: 'NIGHT_THEN_MORNING_NEXT_DAY'
    }
];

let pass = 0, fail = 0;
scenarios.forEach(sc => {
    // Doplnime zbytek slotu nahodne, aby se neignoroval kvuli UNCOVERED_SLOT
    // Pro nas test staci allowPartialCoverage = true
    const result = validateGeneratedSchedule(
        { shifts: sc.shifts, notes: 'test' },
        { product, capabilities: caps, existingShifts: [], monthLabel: 'June 2026', allowPartialCoverage: true }
    );
    const codes = result.errors.map(e => e.code);
    const found = codes.includes(sc.expectCode);
    if (found) {
        console.log('PASS:', sc.name, '→', sc.expectCode);
        pass++;
    } else {
        console.log('FAIL:', sc.name, '→ ocekavano', sc.expectCode, 'ale dostali jsme:', codes.join(', ') || '(nic)');
        fail++;
    }
});

console.log('');
console.log('Summary:', pass, 'pass /', fail, 'fail');
process.exit(fail > 0 ? 1 : 0);
