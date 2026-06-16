// scripts/preview-prompt-mock.js
// MOCK varianta preview generatoru — nepouziva Google API, hodi se do sandboxu
// nebo pro rychly nahled, jak vypada cely prompt.
//
// Pouziva fake Capabilities (3 produkty, 8 lidi) a par dovolenych.
// Vystup: outputs/mock-prompt.txt + outputs/mock-meta.json
//
// Spousteni: node scripts/preview-prompt-mock.js

const fs = require('fs');
const path = require('path');

const {
    buildGeneratorPrompt,
    parseMonthLabel,
    getMonthDates,
    getProductMeta,
    getCoverageProfile,
    peopleHierarchy
} = require('..');

// ---- MOCK DATA --------------------------------------------------------------

const monthLabel = 'June 2026';
const product = 'Valhalla Cup A';

// Capabilities — minimalisticke: 8 lidi, 3 produkty
const mockCaps = {
    products: ['Valhalla Cup A', 'Valhalla Cup B', 'Table Tennis'],
    byProduct: {
        'Valhalla Cup A': [
            'Lukáš Novotný', 'Filip Sklenička', 'Adam Zach', 'Jan Bouška',
            'Denis M.', 'Jakub K.', 'Adrian M.', 'Andres'
        ],
        'Valhalla Cup B': ['Lukáš Novotný', 'Filip Sklenička', 'Adam Zach', 'Jan Bouška'],
        'Table Tennis': ['Adrian M.', 'Andres', 'Christian C.']
    },
    byPerson: {
        'Lukáš Novotný': ['Valhalla Cup A', 'Valhalla Cup B'],
        'Filip Sklenička': ['Valhalla Cup A', 'Valhalla Cup B'],
        'Adam Zach': ['Valhalla Cup A', 'Valhalla Cup B'],
        'Jan Bouška': ['Valhalla Cup A', 'Valhalla Cup B'],
        'Denis M.': ['Valhalla Cup A'],
        'Jakub K.': ['Valhalla Cup A'],
        'Adrian M.': ['Valhalla Cup A', 'Table Tennis'],
        'Andres': ['Valhalla Cup A', 'Table Tennis'],
        'Christian C.': ['Table Tennis']
    },
    personMeta: {},
    generatedAt: new Date().toISOString()
};

// Doplnime personMeta z peopleHierarchy
peopleHierarchy.forEach(g => {
    g.members.forEach(m => {
        if (mockCaps.byPerson[m]) {
            mockCaps.personMeta[m] = { group: g.label, weeklyTarget: g.target, color: g.color };
        }
    });
});

// ManualShifts: par dovolenych + jedna existujici smena na jinem produktu
const mockExisting = [
    { Date: '2026-06-03', Name: 'Lukáš Novotný', Product: 'Vacation', Start: '', End: '' },
    { Date: '2026-06-04', Name: 'Lukáš Novotný', Product: 'Vacation', Start: '', End: '' },
    { Date: '2026-06-05', Name: 'Lukáš Novotný', Product: 'Vacation', Start: '', End: '' },
    { Date: '2026-06-15', Name: 'Adam Zach', Product: 'RIP', Start: '', End: '' },
    // existujici smena na jinem produktu (Valhalla Cup B)
    { Date: '2026-06-08', Name: 'Filip Sklenička', Product: 'Valhalla Cup B', Start: '07:14', End: '15:30' },
];

// ---- BUILD PROMPT ----------------------------------------------------------

const parsed = parseMonthLabel(monthLabel);
const dates = getMonthDates(parsed.year, parsed.month);
const coverage = getCoverageProfile(product);

const prompt = buildGeneratorPrompt({
    monthLabel,
    product,
    capabilities: mockCaps,
    existingShifts: mockExisting,
    rules: { allowPartialCoverage: false }
});

// ---- WRITE OUTPUT ----------------------------------------------------------

const outDir = path.join(__dirname, '..', 'outputs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const promptFile = path.join(outDir, 'mock-prompt.txt');
const metaFile = path.join(outDir, 'mock-meta.json');

fs.writeFileSync(
    promptFile,
    '=== SYSTEM PROMPT ===\n\n' + prompt.system + '\n\n=== USER MESSAGE ===\n\n' + prompt.user,
    'utf8'
);

const meta = {
    monthLabel,
    product,
    coverage,
    daysInMonth: dates.length,
    eligibleCount: mockCaps.byProduct[product].length,
    eligiblePeople: mockCaps.byProduct[product],
    existingShiftsCount: mockExisting.length,
    promptStats: {
        systemChars: prompt.system.length,
        userChars: prompt.user.length,
        totalChars: prompt.system.length + prompt.user.length,
        estimatedTokens: Math.round((prompt.system.length + prompt.user.length) / 4)
    }
};
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');

console.log('[mock] Prompt zapsan:', promptFile);
console.log('[mock] Meta zapsana:', metaFile);
console.log('[mock] System prompt:', prompt.system.length, 'znaku');
console.log('[mock] User message:', prompt.user.length, 'znaku');
console.log('[mock] Celkem ~', Math.round((prompt.system.length + prompt.user.length) / 4), 'tokenu');
