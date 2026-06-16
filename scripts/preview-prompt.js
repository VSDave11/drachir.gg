// scripts/preview-prompt.js
// Standalone preview generatoru — bez bezici Express app a bez Anthropic API klice.
// Nacte Capabilities + ManualShifts z Google Sheets, postavi prompt pro Claude
// a ulozi ho do outputs/ pro inspekci.
//
// Spousteni:
//   node scripts/preview-prompt.js "June 2026" "Valhalla Cup A"
//   node scripts/preview-prompt.js "June 2026" "Table Tennis"
//
// Vystupy:
//   outputs/preview-<month>-<product>-prompt.txt   — kompletni system + user prompt
//   outputs/preview-<month>-<product>-meta.json    — metadata (eligible lidi, sloty, dovolene)

const fs = require('fs');
const path = require('path');

// Importuje vsechny exportovane funkce z index.js (bez startu serveru)
const {
    loadCapabilities,
    loadAllShifts,
    buildGeneratorPrompt,
    parseMonthLabel,
    getMonthDates,
    getProductMeta,
    getCoverageProfile,
    productCoverage
} = require('..');

async function main() {
    const monthLabel = process.argv[2] || 'June 2026';
    const product = process.argv[3] || 'Valhalla Cup A';

    console.log('[preview] Month:', monthLabel);
    console.log('[preview] Product:', product);

    const parsed = parseMonthLabel(monthLabel);
    if (!parsed) {
        console.error('Spatny format month label. Pouzij napr. "June 2026".');
        process.exit(1);
    }

    const pm = getProductMeta(product);
    if (!pm) {
        console.error('Produkt nenalezen v productMapping:', product);
        process.exit(1);
    }

    console.log('[preview] Nacitam Capabilities z Google Sheets...');
    const caps = await loadCapabilities();
    const eligible = caps.byProduct[product] || [];
    console.log('[preview] Eligible lidi pro produkt:', eligible.length);

    console.log('[preview] Nacitam vsechny smeny (ManualShifts + Schedule listy)...');
    const allShifts = await loadAllShifts(true);
    console.log('[preview] Celkem smen v systemu:', allShifts.length);

    // Dovolene v cilovem mesici
    const monthPrefix = parsed.year + '-' + String(parsed.month).padStart(2, '0');
    const vacations = allShifts.filter(s =>
        s.Date && s.Date.startsWith(monthPrefix) &&
        (s.Product === 'Vacation' || s.Product === 'RIP')
    );
    const vacationByPerson = {};
    vacations.forEach(v => {
        vacationByPerson[v.Name] = vacationByPerson[v.Name] || [];
        vacationByPerson[v.Name].push(v.Date);
    });

    // Pripravim coverage info
    const coverage = getCoverageProfile(product);
    const dates = getMonthDates(parsed.year, parsed.month);
    const activeDates = dates.filter(d => {
        if (coverage.days === 'weekdays') return d.dow >= 1 && d.dow <= 5;
        if (coverage.days === 'weekends') return d.dow === 0 || d.dow === 6;
        return true;
    });

    console.log('[preview] Stavim prompt...');
    const prompt = buildGeneratorPrompt({
        monthLabel,
        product,
        capabilities: caps,
        existingShifts: allShifts,
        rules: { allowPartialCoverage: false }
    });

    // Vystupni cesty
    const outDir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const safeMonth = monthLabel.replace(/\s+/g, '-');
    const safeProduct = product.replace(/\s+/g, '-');
    const promptFile = path.join(outDir, `preview-${safeMonth}-${safeProduct}-prompt.txt`);
    const metaFile = path.join(outDir, `preview-${safeMonth}-${safeProduct}-meta.json`);

    const promptContent =
        '=== SYSTEM PROMPT ===\n\n' + prompt.system +
        '\n\n=== USER MESSAGE ===\n\n' + prompt.user;

    fs.writeFileSync(promptFile, promptContent, 'utf8');

    const meta = {
        monthLabel,
        product,
        productMeta: {
            trading: pm.trading,
            slots: pm.slots,
            coverage
        },
        daysInMonth: dates.length,
        activeDays: activeDates.length,
        activeSlots: coverage.slots,
        totalSlotsToFill: activeDates.length * coverage.slots.length,
        eligibleCount: eligible.length,
        eligiblePeople: eligible,
        vacationsThisMonth: {
            totalDays: vacations.length,
            peopleOnVacation: Object.keys(vacationByPerson).length,
            byPerson: vacationByPerson
        },
        promptStats: {
            systemChars: prompt.system.length,
            userChars: prompt.user.length,
            totalChars: prompt.system.length + prompt.user.length,
            estimatedTokens: Math.round((prompt.system.length + prompt.user.length) / 4)
        }
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');

    console.log('');
    console.log('[preview] === HOTOVO ===');
    console.log('[preview] Prompt zapsan:', promptFile);
    console.log('[preview] Meta zapsana:', metaFile);
    console.log('[preview] Eligible lidi:', eligible.length);
    console.log('[preview] Dni v mesici:', dates.length, '| Aktivni dni:', activeDates.length);
    console.log('[preview] Aktivnich slotu:', coverage.slots.join(','));
    console.log('[preview] Celkem slotu k zaplneni:', activeDates.length * coverage.slots.length);
    console.log('[preview] Dovolenych dni v mesici:', vacations.length, '(' + Object.keys(vacationByPerson).length + ' lidi)');
    console.log('[preview] Velikost promptu:', meta.promptStats.totalChars, 'znaku ~', meta.promptStats.estimatedTokens, 'tokenu');
}

main().catch(e => {
    console.error('[preview] CHYBA:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
