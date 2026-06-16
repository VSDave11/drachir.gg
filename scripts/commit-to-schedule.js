// scripts/commit-to-schedule.js
// Propise vygenerovane smeny z live-generation result.json do Schedule - <Month> listu.
//
// Default = DRY-RUN — jen vypise, co by udelal. Pro skutecny zapis: --commit
//
// Spousteni:
//   node scripts/commit-to-schedule.js outputs/live-July-2026-Valhalla-Cup-A-result.json
//   node scripts/commit-to-schedule.js outputs/live-July-2026-Valhalla-Cup-A-result.json --commit
//   node scripts/commit-to-schedule.js outputs/live-July-2026-Valhalla-Cup-A-result.json --commit --overwrite
//
// Konvence pro nocni (slot 0) sloty: Claude pouziva datum=start, Schedule sheet datum=end.
// Takze pro nocni zapise do radku [date+1]. Pokud date+1 padne mimo cilovy mesic, smena se preskoci.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
}));

const resultPath = positional[0];
const dryRun = !flags.commit;
const overwrite = !!flags.overwrite;

if (!resultPath) {
    console.error('Pouziti: node scripts/commit-to-schedule.js <result.json> [--commit] [--overwrite]');
    process.exit(1);
}
if (!fs.existsSync(resultPath)) {
    console.error('Soubor nenalezen:', resultPath);
    process.exit(1);
}

const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
console.log(`[commit] Mode: ${dryRun ? 'DRY-RUN (zadny zapis)' : 'COMMIT (zapise do Sheet)'}`);
console.log(`[commit] Overwrite: ${overwrite ? 'ANO (prepise existujici)' : 'NE (preskoci konflikty)'}`);
console.log(`[commit] Result: ${result.monthLabel} / ${result.product} (${result.shifts?.length || 0} smen)`);
console.log('');

const { doc, productMapping, parseMonthLabel } = require('..');

function isOvernight(slot) {
    const startH = parseInt(slot.s.split(':')[0]);
    const endH = parseInt(slot.e.split(':')[0]);
    return startH >= 20 && endH < 12;
}

function addDays(isoDate, n) {
    const d = new Date(isoDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

async function main() {
    console.log('[commit] Nacitam Google Sheets...');
    await doc.loadInfo();

    const sheetTitle = 'Schedule - ' + result.monthLabel;
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) {
        console.error('[commit] CHYBA: list "' + sheetTitle + '" neexistuje v Sheet.');
        console.error('[commit] Dostupne Schedule listy:', Object.keys(doc.sheetsByTitle).filter(t => t.startsWith('Schedule -')));
        process.exit(2);
    }
    console.log(`[commit] List nalezen: "${sheetTitle}" (rows=${sheet.rowCount}, cols=${sheet.columnCount})`);

    const pm = productMapping.find(p => p.name === result.product);
    if (!pm) {
        console.error('[commit] CHYBA: produkt nenalezen v productMapping:', result.product);
        process.exit(3);
    }
    console.log(`[commit] Produkt: ${pm.name} (startCol=${pm.startCol}, slots: ${pm.slots.map(s => s.s + '-' + s.e).join(', ')})`);

    // Load cells covering all dates + product columns
    const maxRow = Math.min(sheet.rowCount, 500);
    const lastSlotCol = pm.startCol + Math.max(...pm.slots.map(s => s.o));
    const rangeA1 = `A1:${String.fromCharCode(65 + lastSlotCol)}${maxRow}`;
    // For columns beyond Z, we need a different approach; helper:
    function colToLetter(c) {
        let s = '';
        let n = c + 1;
        while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
        return s;
    }
    const range = `A1:${colToLetter(lastSlotCol)}${maxRow}`;
    console.log(`[commit] Nacitam bunky v rozsahu ${range}...`);
    await sheet.loadCells(range);

    // Build date -> row map (col 0 = Date)
    const { convertCzechDate } = (() => {
        // helper: pull convertCzechDate from index.js via require - but it's not exported.
        // Re-implementujeme tady jednoduchou verzi: bere Date objekt nebo cesky/iso string.
        function convertCzechDate(val) {
            if (val == null || val === '') return null;
            // Sheets serial number -> ISO
            if (typeof val === 'number') {
                const ms = (val - 25569) * 86400000;
                return new Date(ms).toISOString().slice(0, 10);
            }
            const s = String(val).trim();
            // D.M.YYYY (Czech)
            const mCz = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
            if (mCz) {
                const d = String(mCz[1]).padStart(2,'0');
                const m = String(mCz[2]).padStart(2,'0');
                return `${mCz[3]}-${m}-${d}`;
            }
            // ISO already
            const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (mIso) return s.slice(0, 10);
            return null;
        }
        return { convertCzechDate };
    })();

    const dateToRow = new Map();
    for (let r = 0; r < maxRow; r++) {
        const cell = sheet.getCell(r, 0);
        const v = cell.formattedValue || cell.value;
        const iso = convertCzechDate(v);
        if (iso) dateToRow.set(iso, r);
    }
    console.log(`[commit] Datum->row map: ${dateToRow.size} validnich radku`);

    const parsed = parseMonthLabel(result.monthLabel);
    const monthPrefix = parsed.year + '-' + String(parsed.month).padStart(2, '0');

    // Plan changes
    const plan = []; // { date, slotIndex, person, targetRow, targetCol, currentValue, action }
    const skipped = [];

    for (const s of result.shifts) {
        const slot = pm.slots[s.slotIndex];
        const isOver = isOvernight(slot);
        // Sheet datum = (Claude date) +1 pokud overnight, jinak stejne
        const sheetDate = isOver ? addDays(s.date, 1) : s.date;

        const row = dateToRow.get(sheetDate);
        if (row === undefined) {
            skipped.push({ shift: s, reason: `sheet date ${sheetDate} nenalezen v listu (mimo rozsah sheetu)` });
            continue;
        }
        const col = pm.startCol + slot.o;
        const cell = sheet.getCell(row, col);
        const currentValue = cell.value;

        let action;
        if (currentValue == null || currentValue === '' || currentValue === '-') {
            action = 'WRITE';
        } else if (String(currentValue).trim() === s.person) {
            action = 'SAME'; // uz tam je presne to jmeno
        } else if (overwrite) {
            action = 'OVERWRITE';
        } else {
            action = 'CONFLICT';
        }

        plan.push({
            date: s.date, sheetDate, slotIndex: s.slotIndex, kind: ['night','morning','afternoon'][s.slotIndex],
            person: s.person, targetRow: row + 1 /* 1-based pro display */, targetCol: colToLetter(col),
            currentValue: currentValue == null ? '' : String(currentValue), action
        });
    }

    // Summary
    const actionCounts = plan.reduce((acc, p) => { acc[p.action] = (acc[p.action] || 0) + 1; return acc; }, {});
    console.log('');
    console.log('[commit] === PLAN ===');
    console.log(`[commit] Vsechny smeny v result: ${result.shifts.length}`);
    console.log(`[commit] V planu zapisu: ${plan.length}`);
    console.log(`[commit] Preskoceno (cross-month nebo neexist. radek): ${skipped.length}`);
    console.log(`[commit] Z toho:`);
    Object.entries(actionCounts).forEach(([a, n]) => console.log(`  ${a}: ${n}`));

    // Show first 5 conflicts (if any)
    const conflicts = plan.filter(p => p.action === 'CONFLICT');
    if (conflicts.length > 0) {
        console.log('');
        console.log(`[commit] KONFLIKTY (${conflicts.length} celkem, prvnich 10):`);
        conflicts.slice(0, 10).forEach(p => {
            console.log(`  ${p.sheetDate} ${p.kind} (radek ${p.targetRow} col ${p.targetCol}): chceme "${p.person}", v bunce "${p.currentValue}"`);
        });
        console.log('  → Pouzij --overwrite pro prepis, nebo nejdriv vycisti rucne v Sheet.');
    }

    // Show skipped
    if (skipped.length > 0) {
        console.log('');
        console.log(`[commit] PRESKOCENO (${skipped.length}):`);
        skipped.slice(0, 10).forEach(s => {
            console.log(`  ${s.shift.date} slot ${s.shift.slotIndex} (${s.shift.person}): ${s.reason}`);
        });
    }

    if (dryRun) {
        console.log('');
        console.log('[commit] === DRY-RUN — ZADNY ZAPIS ===');
        console.log('[commit] Pro skutecny zapis spust znovu s --commit');
        if (conflicts.length > 0 && !overwrite) {
            console.log('[commit] Pro prepis konfliktu pridej --overwrite');
        }
        return;
    }

    // COMMIT
    if (conflicts.length > 0 && !overwrite) {
        console.log('');
        console.log(`[commit] CHYBA: ${conflicts.length} konfliktu a --overwrite neni nastaven. Abort.`);
        process.exit(4);
    }

    console.log('');
    console.log('[commit] === ZAPISUJU ===');
    let written = 0;
    for (const p of plan) {
        if (p.action === 'SAME') continue; // uz tam je
        const cell = sheet.getCell(p.targetRow - 1, pm.startCol + p.slotIndex);
        cell.value = p.person;
        written++;
    }
    console.log(`[commit] Pripravuje se zapis ${written} bunek...`);
    await sheet.saveUpdatedCells();
    console.log(`[commit] === HOTOVO === Zapsano ${written} bunek do "${sheetTitle}"`);
}

main().catch(e => {
    console.error('[commit] CHYBA:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
