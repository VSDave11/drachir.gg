// scripts/batch-local-solver.js
// Spousti local CSP solver pro VSECHNY produkty pro dany mesic.
// Po kazdem produktu: validuje, commitne do Sheet (s overwrite), pak akumuluje shifts pro dalsi produkt.
//
// Pouziti:
//   node scripts/batch-local-solver.js "July 2026"
//   node scripts/batch-local-solver.js "July 2026" --clear        # nejdriv vymaze sheet
//   node scripts/batch-local-solver.js "July 2026" --no-commit    # jen vygeneruje, nezapise
//   node scripts/batch-local-solver.js "July 2026" --product=Cricket  # jen jeden produkt
//
// Vystupy:
//   outputs/batch-local-<month>-summary.json — souhrn vsech produktu
//   outputs/batch-local-<month>-<product>-result.json — kazdy produkt zvlast

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
}));

const monthLabel = positional[0];
const doCommit = !flags['no-commit'];
const doClear = !!flags.clear;
const specificProduct = flags.product || null;

if (!monthLabel) {
    console.error('Pouziti: node scripts/batch-local-solver.js "July 2026" [--clear] [--no-commit] [--product=Cricket]');
    process.exit(1);
}

const idx = require('..');
const { solveSchedule } = require('../lib/local-solver');

function colToLetter(c) {
    let s = ''; let n = c + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

function isOvernight(slot) {
    const sh = parseInt(slot.s.split(':')[0]);
    const eh = parseInt(slot.e.split(':')[0]);
    return sh >= 20 && eh < 12;
}

function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function convertCzechDate(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number') {
        const ms = (val - 25569) * 86400000;
        return new Date(ms).toISOString().slice(0, 10);
    }
    const s = String(val).trim();
    const mCz = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (mCz) {
        return `${mCz[3]}-${String(mCz[2]).padStart(2,'0')}-${String(mCz[1]).padStart(2,'0')}`;
    }
    const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (mIso) return s.slice(0, 10);
    return null;
}

async function clearSheet(sheet) {
    console.log('[batch] === CLEARING SHEET ===');
    const colsToClear = new Set();
    idx.productMapping.forEach(pm => {
        const maxOffset = Math.max(...pm.slots.map(s => s.o));
        for (let off = 0; off <= maxOffset; off++) {
            colsToClear.add(pm.startCol + off);
        }
    });
    const sortedCols = Array.from(colsToClear).sort((a, b) => a - b);
    const lastCol = Math.max(...sortedCols);
    const maxRow = Math.min(sheet.rowCount, 500);
    await sheet.loadCells(`A1:${colToLetter(lastCol)}${maxRow}`);
    let cleared = 0;
    for (let r = 0; r < maxRow; r++) {
        const dc = sheet.getCell(r, 0);
        if (!(dc.value || dc.formattedValue)) continue;
        for (const col of sortedCols) {
            const cell = sheet.getCell(r, col);
            if (cell.value != null && String(cell.value).trim() !== '') {
                cell.value = null;
                cleared++;
            }
        }
    }
    await sheet.saveUpdatedCells();
    console.log('[batch] Cleared ' + cleared + ' cells\n');
}

async function commitShifts(sheet, dateToRow, pm, shifts) {
    let written = 0;
    for (const s of shifts) {
        const slot = pm.slots[s.slotIndex];
        const sheetDate = isOvernight(slot) ? addDays(s.date, 1) : s.date;
        const row = dateToRow.get(sheetDate);
        if (row === undefined) continue; // out of sheet range
        const col = pm.startCol + slot.o;
        const cell = sheet.getCell(row, col);
        cell.value = s.person;
        written++;
    }
    if (written > 0) await sheet.saveUpdatedCells();
    return written;
}

async function main() {
    const t0 = Date.now();
    console.log('[batch] Month:', monthLabel);
    console.log('[batch] Clear first:', doClear);
    console.log('[batch] Commit:', doCommit);
    if (specificProduct) console.log('[batch] Only product:', specificProduct);
    console.log('');

    console.log('[batch] Nacitam Sheets...');
    await idx.doc.loadInfo();
    const sheetTitle = 'Schedule - ' + monthLabel;
    const sheet = idx.doc.sheetsByTitle[sheetTitle];
    if (!sheet) { console.error('Sheet not found:', sheetTitle); process.exit(2); }

    if (doClear && doCommit) {
        await clearSheet(sheet);
    }

    // Nacti vsechny smeny + Capabilities
    console.log('[batch] Nacitam Capabilities + ManualShifts...');
    const caps = await idx.loadCapabilities();
    let allShifts = await idx.loadAllShifts(true); // force re-sync

    // Pripravim si date->row map pro commit (preload sheet cells once)
    const maxRow = Math.min(sheet.rowCount, 500);
    const maxCol = Math.max(...idx.productMapping.map(p => p.startCol + Math.max(...p.slots.map(s => s.o))));
    await sheet.loadCells(`A1:${colToLetter(maxCol)}${maxRow}`);
    const dateToRow = new Map();
    for (let r = 0; r < maxRow; r++) {
        const cell = sheet.getCell(r, 0);
        const iso = convertCzechDate(cell.formattedValue || cell.value);
        if (iso) dateToRow.set(iso, r);
    }

    const deps = {
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
    };

    const productsToRun = specificProduct
        ? idx.productMapping.filter(p => p.name === specificProduct).map(p => p.name)
        : idx.productMapping.map(p => p.name);

    const summary = { monthLabel, products: [], totalFilled: 0, totalUnfilled: 0, totalErrors: 0 };
    const accumulated = [...allShifts]; // start with all existing

    const outDir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    for (let i = 0; i < productsToRun.length; i++) {
        const product = productsToRun[i];
        console.log(`\n[batch] [${i+1}/${productsToRun.length}] ${product}`);

        const pm = idx.getProductMeta(product);
        if (!pm) { console.log('  skip — unknown product'); continue; }
        if (!(caps.byProduct[product] || []).length) { console.log('  skip — no eligible people'); continue; }

        const result = solveSchedule({
            monthLabel, product, capabilities: caps,
            existingShifts: accumulated,
            rules: { allowPartialCoverage: true },
            deps
        });

        const validation = idx.validateGeneratedSchedule(
            { shifts: result.shifts, notes: result.notes },
            { product, capabilities: caps, existingShifts: accumulated, monthLabel, allowPartialCoverage: true }
        );

        // Filter "real" errors — only errors involving generated.shifts' people
        const generatedPersons = new Set(result.shifts.map(s => s.person));
        const realErrors = validation.errors.filter(e => {
            // pokud msg obsahuje jmeno generated osoby, je to nase error
            const lower = e.msg.toLowerCase();
            for (const p of generatedPersons) {
                if (lower.includes(p.toLowerCase())) return true;
            }
            return false;
        });

        console.log(`  Filled: ${result.stats.filled}/${result.stats.totalTasks}, unfilled: ${result.stats.unfilled}, time: ${result.elapsedMs}ms`);
        console.log(`  Real errors: ${realErrors.length} (total flagged: ${validation.errors.length})`);
        if (realErrors.length > 0) {
            console.log('  First 3 real errors:');
            realErrors.slice(0, 3).forEach(e => console.log('    -', e.code + ':', e.msg));
        }

        summary.products.push({
            product, filled: result.stats.filled, total: result.stats.totalTasks,
            unfilled: result.stats.unfilled, realErrors: realErrors.length,
            warnings: validation.warnings.length, elapsedMs: result.elapsedMs
        });
        summary.totalFilled += result.stats.filled;
        summary.totalUnfilled += result.stats.unfilled;
        summary.totalErrors += realErrors.length;

        // Save per-product result
        const safe = (product.replace(/\s+/g, '-'));
        fs.writeFileSync(
            path.join(outDir, `batch-local-${monthLabel.replace(/\s+/g,'-')}-${safe}-result.json`),
            JSON.stringify({ ...result, validation, realErrors }, null, 2)
        );

        // Accumulate (so next products see this product's assignments)
        const enriched = result.shifts.map(s => {
            const slot = pm.slots[s.slotIndex];
            return {
                Date: s.date, Name: s.person, Product: product,
                Start: slot ? slot.s : '', End: slot ? slot.e : ''
            };
        });
        accumulated.push(...enriched);

        // Commit
        if (doCommit) {
            console.log('  Committing...');
            const written = await commitShifts(sheet, dateToRow, pm, result.shifts);
            console.log('  Committed ' + written + ' cells');
        }
    }

    // Save summary
    fs.writeFileSync(
        path.join(outDir, `batch-local-${monthLabel.replace(/\s+/g,'-')}-summary.json`),
        JSON.stringify(summary, null, 2)
    );

    const elapsedMin = ((Date.now() - t0) / 60000).toFixed(2);
    console.log('\n[batch] === HOTOVO ===');
    console.log(`Total filled: ${summary.totalFilled}, unfilled: ${summary.totalUnfilled}, real errors: ${summary.totalErrors}`);
    console.log(`Cas: ${elapsedMin} min`);
    console.log(`Summary: outputs/batch-local-${monthLabel.replace(/\s+/g,'-')}-summary.json`);
}

main().catch(e => {
    console.error('[batch] CHYBA:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
