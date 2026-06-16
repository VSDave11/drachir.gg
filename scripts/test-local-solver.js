// scripts/test-local-solver.js
// Test local CSP solveru bez Anthropic API. Vola loadCapabilities + loadAllShifts
// (= Google Sheets, takze potreba lokalne s credentials.json).
//
// Pouziti:
//   node scripts/test-local-solver.js "July 2026" "Valhalla Cup A"
//   node scripts/test-local-solver.js "July 2026" "Valhalla Cup B"
//
// Vystup:
//   outputs/local-<month>-<product>-result.json — vygenerovany rozvrh
//   outputs/local-<month>-<product>-shifts.csv — pro vizualni check
//   + console: stats + 5 sample shifts
//
// Pozn.: prochazi i validateGeneratedSchedule, aby video bylo, kolik chyb / warningu

const fs = require('fs');
const path = require('path');

const monthLabel = process.argv[2] || 'July 2026';
const product = process.argv[3] || 'Valhalla Cup A';

const idx = require('..');
const { solveSchedule } = require('../lib/local-solver');

async function main() {
    console.log('[local] Month:', monthLabel);
    console.log('[local] Product:', product);
    console.log('');

    console.log('[local] 1/4 Nacitam Capabilities + ManualShifts...');
    const caps = await idx.loadCapabilities();
    const allShifts = await idx.loadAllShifts(true);
    if (!caps.byProduct[product]) { console.error('Unknown product:', product); process.exit(1); }
    console.log('[local]    eligible:', caps.byProduct[product].length);

    console.log('[local] 2/4 Spoustim local CSP solver...');
    const result = solveSchedule({
        monthLabel,
        product,
        capabilities: caps,
        existingShifts: allShifts,
        rules: { allowPartialCoverage: true },
        deps: {
            parseMonthLabel: idx.parseMonthLabel,
            getMonthDates: idx.getMonthDates,
            getProductMeta: idx.getProductMeta,
            getCoverageProfile: idx.getCoverageProfile,
            isDateInCoverage: (d, cov) => {
                if (cov.days === 'all') return true;
                if (cov.days === 'weekdays') return d.dow >= 1 && d.dow <= 5;
                if (cov.days === 'weekends') return d.dow === 0 || d.dow === 6;
                return true;
            }
        }
    });

    console.log('[local]    solved in', result.elapsedMs, 'ms');
    console.log('[local]    filled:', result.stats.filled, '/', result.stats.totalTasks);
    console.log('[local]    unfilled:', result.stats.unfilled);

    console.log('[local] 3/4 Validating output...');
    const validation = idx.validateGeneratedSchedule(
        { shifts: result.shifts, notes: result.notes },
        { product, capabilities: caps, existingShifts: allShifts, monthLabel, allowPartialCoverage: true }
    );
    console.log('[local]    errors:', validation.errors.length, '| warnings:', validation.warnings.length);
    if (validation.errors.length > 0) {
        console.log('[local]    Errors (first 5):');
        validation.errors.slice(0, 5).forEach(e => console.log('      -', e.code + ':', e.msg));
    }

    // Save outputs
    const outDir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const safeMonth = monthLabel.replace(/\s+/g, '-');
    const safeProduct = product.replace(/\s+/g, '-');
    const resultFile = path.join(outDir, `local-${safeMonth}-${safeProduct}-result.json`);
    const csvFile = path.join(outDir, `local-${safeMonth}-${safeProduct}-shifts.csv`);

    const pm = idx.getProductMeta(product);
    const enriched = result.shifts.map(s => {
        const slot = pm && pm.slots[s.slotIndex];
        return {
            Date: s.date,
            SlotKind: ['night', 'morning', 'afternoon'][s.slotIndex],
            SlotIndex: s.slotIndex,
            Name: s.person,
            Start: slot ? slot.s : '',
            End: slot ? slot.e : ''
        };
    });
    fs.writeFileSync(resultFile, JSON.stringify({
        monthLabel, product, ...result, validation, enriched
    }, null, 2));
    const csv = 'Date,SlotKind,SlotIndex,Person,Start,End\n' +
        enriched.sort((a, b) => a.Date.localeCompare(b.Date) || a.SlotIndex - b.SlotIndex)
            .map(s => [s.Date, s.SlotKind, s.SlotIndex, s.Name, s.Start, s.End].join(','))
            .join('\n');
    fs.writeFileSync(csvFile, csv);

    console.log('[local] 4/4 Saved');
    console.log('[local]    Result:', resultFile);
    console.log('[local]    CSV:   ', csvFile);
    console.log('');
    console.log('[local] === SAMPLE FIRST 5 SHIFTS ===');
    enriched.slice(0, 5).forEach(s => console.log('   ' + s.Date + ' ' + s.SlotKind.padEnd(10) + ' ' + s.Name));
}

main().catch(e => {
    console.error('[local] ERROR:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
