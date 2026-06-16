// lib/local-solver.js
// Local CSP solver pro generovani rozvrhu BEZ Anthropic API.
//
// Algoritmus:
//   1. Pripravi tasks = vsechny (date, slot) kombinace pro produkt v mesici
//   2. Razene tasky podle "obtiznosti" (nejmenej kandidatu napred)
//   3. Pro kazdy task vybere kandidata podle heuristiky:
//      - lowest current-vs-target ratio (most under target)
//      - tiebreaker: lowest total assigned shifts
//   4. Pokud neexistuje validni kandidat, slot zustane prazdny
//
// Vystup: stejny tvar jako /api/generate-schedule (shifts array + notes)
//
// Hard constraints H1-H9 jsou implementovany v canAssign(). Soft constraints S1-S5
// jsou aproximovane heuristikou — neoptimalizujeme presne, jen preferujeme rozumna reseni.

const NO_NIGHT_GROUPS = new Set(['Team Leaders', 'Title Experts', 'Quality Assurance', 'Master Scheduler']);
const SLOT_KIND = ['night', 'morning', 'afternoon'];

function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Klasifikace existujici smeny podle Start hodiny (mirror validator logiky)
// Vraci ISO datum pondeli toho tydne (pondeli = zacatek tydne)
function weekStart(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0=Ne, 1=Po
    const offsetToMon = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + offsetToMon);
    return d.toISOString().slice(0, 10);
}

function classifyExistingByStart(start) {
    if (!start || !/^\d{1,2}:/.test(start)) return null;
    const h = parseInt(start.split(':')[0]);
    if (h >= 20 || h < 6) return 'night';
    if (h >= 6 && h < 13) return 'morning';
    return 'afternoon';
}

function solveSchedule({ monthLabel, product, capabilities, existingShifts, rules, deps }) {
    // Naimportujeme pomocne fce z index.js — predame je jako deps (DI), abychom se vyhnuli kruhove zavislosti
    const { parseMonthLabel, getMonthDates, getProductMeta, getCoverageProfile, isDateInCoverage } = deps;

    const t0 = Date.now();
    const parsed = parseMonthLabel(monthLabel);
    if (!parsed) throw new Error('Invalid month label: ' + monthLabel);
    const pm = getProductMeta(product);
    if (!pm) throw new Error('Unknown product: ' + product);
    const coverage = getCoverageProfile(product);
    const allMonthDates = getMonthDates(parsed.year, parsed.month);
    const activeDates = allMonthDates.filter(d => isDateInCoverage(d, coverage));
    const activeSlots = coverage.slots;
    const monthPrefix = parsed.year + '-' + String(parsed.month).padStart(2, '0');

    const eligible = (capabilities.byProduct[product] || []).filter(n => capabilities.personMeta[n]);
    if (eligible.length === 0) {
        return {
            shifts: [], notes: 'No eligible people for ' + product, unfilledSlots: [],
            elapsedMs: Date.now() - t0,
            stats: { totalTasks: 0, filled: 0, unfilled: 0 }
        };
    }

    // === PRIPRAVA EXISTING SHIFTS ===
    // Vacations: name -> Set(dates)
    // Other-product shifts: name -> Map(date -> kind)
    // (vsechno omezeno na eligible + tento mesic + ne current product)
    const eligibleSet = new Set(eligible);
    const vacations = {};
    const otherShiftKind = {}; // person -> date -> kind

    existingShifts.forEach(s => {
        if (!s.Date || !s.Date.startsWith(monthPrefix)) return;
        if (!eligibleSet.has(s.Name)) return;
        if (s.Product === 'Vacation' || s.Product === 'RIP') {
            if (!vacations[s.Name]) vacations[s.Name] = new Set();
            vacations[s.Name].add(s.Date);
            return;
        }
        if (s.Product === product) return; // regenerating this product, skip its own existing
        const kind = classifyExistingByStart(s.Start);
        if (!kind) return;
        if (!otherShiftKind[s.Name]) otherShiftKind[s.Name] = {};
        if (!otherShiftKind[s.Name][s.Date]) otherShiftKind[s.Name][s.Date] = new Set();
        otherShiftKind[s.Name][s.Date].add(kind);
    });

    // === STATE ===
    // personDateSlots[name][date] = Set of kinds (combined existing-OTHER + own assignments)
    const personDateSlots = {};
    function getSet(name, date) {
        if (!personDateSlots[name]) personDateSlots[name] = {};
        if (!personDateSlots[name][date]) personDateSlots[name][date] = new Set();
        return personDateSlots[name][date];
    }
    function hasKind(name, date, kind) {
        return personDateSlots[name]?.[date]?.has(kind);
    }
    function hasAnyShiftOnDate(name, date) {
        return (personDateSlots[name]?.[date]?.size || 0) > 0;
    }

    // Predvyplni personDateSlots s existing cross-product shifts
    Object.entries(otherShiftKind).forEach(([name, byDate]) => {
        Object.entries(byDate).forEach(([date, kindSet]) => {
            kindSet.forEach(kind => getSet(name, date).add(kind));
        });
    });

    // personHours: name -> total assigned hours (count from existing other + new)
    const personHours = {};
    Object.entries(otherShiftKind).forEach(([name, byDate]) => {
        let totalKinds = 0;
        Object.values(byDate).forEach(s => totalKinds += s.size);
        personHours[name] = (personHours[name] || 0) + totalKinds * 8;
    });

    // personDays: name -> Set(dates) — pro H5 max 7 consecutive
    const personDays = {};
    function addDay(name, date) {
        if (!personDays[name]) personDays[name] = new Set();
        personDays[name].add(date);
    }
    Object.entries(otherShiftKind).forEach(([name, byDate]) => {
        Object.keys(byDate).forEach(date => addDay(name, date));
    });

    // personWeeklyShifts: name -> weekStart -> count — pro H10 hard weekly cap
    const personWeeklyShifts = {};
    function incrementWeek(name, date) {
        const w = weekStart(date);
        if (!personWeeklyShifts[name]) personWeeklyShifts[name] = {};
        personWeeklyShifts[name][w] = (personWeeklyShifts[name][w] || 0) + 1;
    }
    function getWeekShifts(name, date) {
        return personWeeklyShifts[name]?.[weekStart(date)] || 0;
    }
    // preload from existing cross-product shifts
    Object.entries(otherShiftKind).forEach(([name, byDate]) => {
        Object.keys(byDate).forEach(date => incrementWeek(name, date));
    });

    function hasConsecutiveRunOver7IfAdd(name, newDate) {
        // Pokud bychom pridali newDate do personDays[name], byl by nekde 8+ dny v rade?
        const days = new Set(personDays[name] || []);
        days.add(newDate);
        const sorted = Array.from(days).sort();
        let run = 1;
        for (let i = 1; i < sorted.length; i++) {
            const prev = new Date(sorted[i - 1] + 'T12:00:00Z');
            const cur = new Date(sorted[i] + 'T12:00:00Z');
            const diff = Math.round((cur - prev) / 86400000);
            if (diff === 1) {
                run++;
                if (run > 7) return true;
            } else {
                run = 1;
            }
        }
        return false;
    }

    function canAssign(person, date, slotIndex) {
        const kind = SLOT_KIND[slotIndex];
        // H3 Vacation
        if (vacations[person]?.has(date)) return false;
        // H2 eligible — already filtered

        // Cross-product / intra-day:
        // H6 = no same date cross-product. Plus H4/H8 = no morning+night, afternoon+night same day same person.
        // Simplest: pokud ma jakoukoli smenu ten den, no go.
        if (hasAnyShiftOnDate(person, date)) return false;

        // H7: pokud davame morning, predchozi den nesmel byt night
        if (kind === 'morning') {
            if (hasKind(person, addDays(date, -1), 'night')) return false;
        }
        // H7 reverse: pokud davame night, dalsi den nesmi byt morning (jeste neprideleny, ale ze stavajicich)
        if (kind === 'night') {
            if (hasKind(person, addDays(date, 1), 'morning')) return false;
        }

        // H9: TL/TE/QA/Scheduler no nights
        if (kind === 'night') {
            const meta = capabilities.personMeta[person];
            if (meta && NO_NIGHT_GROUPS.has(meta.group)) return false;
        }

        // H5: max 7 consecutive days
        if (hasConsecutiveRunOver7IfAdd(person, date)) return false;

        // H10: strict weekly target cap
        const metaP = capabilities.personMeta[person];
        const weeklyCap = Math.floor((metaP?.weeklyTarget || 40) / 8);
        if (weeklyCap === 0) return false; // weeklyTarget=0 = no shifts ever
        if (getWeekShifts(person, date) >= weeklyCap) return false;

        return true;
    }

    // === TASKS ===
    const tasks = [];
    activeDates.forEach(d => {
        activeSlots.forEach(sl => {
            tasks.push({ date: d.date, slotIndex: sl, dow: d.dow, isWeekend: d.isWeekend });
        });
    });

    // Razime tasky podle obtiznosti: nejdriv night (mene kandidatu kvuli H9), pak ranni, pak odpoledni.
    // V ramci stejneho kindu chronologicky.
    tasks.sort((a, b) => {
        const ka = a.slotIndex === 0 ? 0 : (a.slotIndex === 1 ? 1 : 2);
        const kb = b.slotIndex === 0 ? 0 : (b.slotIndex === 1 ? 1 : 2);
        if (ka !== kb) return ka - kb;
        return a.date.localeCompare(b.date);
    });

    // === SOLVER (greedy) ===
    const assignments = [];
    const unfilled = [];

    function scoreCandidate(person, taskKind) {
        const meta = capabilities.personMeta[person];
        const weeklyTarget = meta?.weeklyTarget || 40;
        const monthTarget = weeklyTarget * (allMonthDates.length / 7);
        const current = personHours[person] || 0;
        const ratio = monthTarget > 0 ? current / monthTarget : 99;
        // PRIORITY: Traders first (Europe/Lima). TE/TL/QA only as fallback when all Traders saturated.
        const groupName = meta?.group || '';
        const isTrader = groupName.startsWith('Traders');
        const isHead = groupName.startsWith('Head of Trading');
        // Score: traders get 0-1 range, head 1-2, TE/TL/QA/Scheduler get 10+
        // Within each tier, lower ratio = picked first.
        const tierBase = isTrader ? 0 : (isHead ? 1 : 10);
        return tierBase + ratio;
    }

    for (const task of tasks) {
        const candidates = eligible.filter(p => canAssign(p, task.date, task.slotIndex));
        if (candidates.length === 0) {
            unfilled.push({ ...task, reason: 'no_eligible_candidate' });
            continue;
        }
        // setrideni dle skore (lowest first = under-target prefer)
        candidates.sort((a, b) => scoreCandidate(a) - scoreCandidate(b));
        const chosen = candidates[0];

        // commit
        getSet(chosen, task.date).add(SLOT_KIND[task.slotIndex]);
        personHours[chosen] = (personHours[chosen] || 0) + 8;
        addDay(chosen, task.date);
        incrementWeek(chosen, task.date);
        assignments.push({ date: task.date, slotIndex: task.slotIndex, person: chosen });
    }

    const elapsed = Date.now() - t0;
    const notes = 'Local CSP solver. Filled ' + assignments.length + '/' + tasks.length +
        ' slots in ' + elapsed + 'ms. Unfilled: ' + unfilled.length +
        '. Algorithm: greedy with most-under-target heuristic, hard constraints H1-H9 enforced.';

    return {
        shifts: assignments,
        notes,
        unfilledSlots: unfilled,
        elapsedMs: elapsed,
        stats: {
            totalTasks: tasks.length,
            filled: assignments.length,
            unfilled: unfilled.length
        }
    };
}

module.exports = { solveSchedule };
