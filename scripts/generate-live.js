// scripts/generate-live.js
// LIVE generace rozvrhu — vola Anthropic API a vrati hotove smeny.
// Mirror logiky /api/generate-schedule, ale bez Express session/auth.
//
// Spousteni:
//   node scripts/generate-live.js "June 2026" "Valhalla Cup A"
//   node scripts/generate-live.js "June 2026" "Valhalla Cup A" --model=claude-sonnet-4-6
//   node scripts/generate-live.js "June 2026" "Valhalla Cup A" --apc        # allow partial coverage
//   node scripts/generate-live.js "June 2026" "Valhalla Cup A" --apikey=sk-ant-...   # alt. k env var
//
// API klic: bud nastav env var ANTHROPIC_API_KEY (doporuceno) nebo pouzij --apikey=...
// Ziskat: https://console.anthropic.com → API Keys
//
// Vystupy:
//   outputs/live-<month>-<product>-result.json    — kompletni vysledek (smeny, validace, usage)
//   outputs/live-<month>-<product>-shifts.csv     — CSV pro vizualni kontrolu

const fs = require('fs');
const path = require('path');

// Parse CLI args
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
}));

const monthLabel = positional[0];
const product = positional[1];
const model = flags.model || 'claude-opus-4-7';
const apc = flags.apc === true || flags.apc === 'true';

// Pokud uzivatel zadal --apikey=..., nastav env var pred require()
if (flags.apikey) process.env.ANTHROPIC_API_KEY = flags.apikey;

if (!monthLabel || !product) {
    console.error('Pouziti: node scripts/generate-live.js "June 2026" "Valhalla Cup A" [--apc] [--model=claude-sonnet-4-6] [--apikey=sk-ant-...]');
    process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
    console.error('CHYBA: ANTHROPIC_API_KEY neni nastaven.');
    console.error('  Powershell: $env:ANTHROPIC_API_KEY = "sk-ant-..."');
    console.error('  Cmd: set ANTHROPIC_API_KEY=sk-ant-...');
    console.error('  Nebo: node scripts/generate-live.js ... --apikey=sk-ant-...');
    process.exit(1);
}

const {
    loadCapabilities,
    loadAllShifts,
    buildGeneratorPrompt,
    validateGeneratedSchedule,
    callClaude,
    getProductMeta
} = require('..');

async function main() {
    console.log('[live] Month:', monthLabel);
    console.log('[live] Product:', product);
    console.log('[live] Model:', model);
    console.log('[live] AllowPartialCoverage:', apc);
    console.log('');

    const t0 = Date.now();

    console.log('[live] 1/4 Nacitam Capabilities + ManualShifts...');
    const caps = await loadCapabilities();
    const allShifts = await loadAllShifts(true);

    if (!caps.byProduct[product]) {
        console.error('CHYBA: Produkt nenalezen v Capabilities:', product);
        process.exit(2);
    }
    if ((caps.byProduct[product] || []).length === 0) {
        console.error('CHYBA: Nikdo neni eligible pro:', product);
        process.exit(2);
    }
    console.log('[live]    eligible lidi:', caps.byProduct[product].length);

    console.log('[live] 2/4 Stavim prompt...');
    const prompt = buildGeneratorPrompt({
        monthLabel,
        product,
        capabilities: caps,
        existingShifts: allShifts,
        rules: { allowPartialCoverage: apc }
    });
    const promptChars = prompt.system.length + prompt.user.length;
    console.log('[live]    prompt:', promptChars, 'znaku ~', Math.round(promptChars / 4), 'tokenu');

    console.log('[live] 3/4 Volam Anthropic API (' + model + ')... toto muze trvat 30-90s');
    const submitTool = {
        name: 'submit_schedule',
        description: 'Submit the generated schedule. Call this exactly once with the complete schedule.',
        input_schema: {
            type: 'object',
            properties: {
                shifts: {
                    type: 'array',
                    description: 'One entry per filled slot. Only include active slot/day combos from the coverage profile.',
                    items: {
                        type: 'object',
                        properties: {
                            date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
                            slotIndex: { type: 'integer', enum: [0,1,2], description: '0=night, 1=morning, 2=afternoon' },
                            person: { type: 'string', description: 'Full name exactly as in eligiblePeople' }
                        },
                        required: ['date', 'slotIndex', 'person']
                    }
                },
                notes: { type: 'string', description: 'Short summary of tradeoffs and soft violations' }
            },
            required: ['shifts']
        }
    };

    const tApi = Date.now();
    const claudeResp = await callClaude({
        system: prompt.system,
        userMessage: prompt.user,
        model,
        maxTokens: 32000,
        tools: [submitTool],
        toolChoice: { type: 'tool', name: 'submit_schedule' }
    });
    const apiMs = Date.now() - tApi;
    console.log('[live]    API hotovo za', apiMs, 'ms');

    const toolBlock = (claudeResp.content || []).find(c => c.type === 'tool_use' && c.name === 'submit_schedule');
    if (!toolBlock) {
        console.error('CHYBA: Claude nezavolal submit_schedule tool. Stop reason:', claudeResp.stop_reason);
        const textBlock = (claudeResp.content || []).find(c => c.type === 'text');
        if (textBlock) console.error('Text response:', textBlock.text.slice(0, 1000));
        process.exit(3);
    }
    const generated = toolBlock.input;
    console.log('[live]    smen vygenerovano:', generated.shifts?.length || 0);

    console.log('[live] 4/4 Validuju vystup...');
    const validation = validateGeneratedSchedule(generated, {
        product, capabilities: caps, existingShifts: allShifts, monthLabel, allowPartialCoverage: apc
    });
    console.log('[live]    errors:', validation.errors.length, '| warnings:', validation.warnings.length);

    // Ulozit vysledek
    const outDir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const safeMonth = monthLabel.replace(/\s+/g, '-');
    const safeProduct = product.replace(/\s+/g, '-');
    const resultFile = path.join(outDir, `live-${safeMonth}-${safeProduct}-result.json`);
    const csvFile = path.join(outDir, `live-${safeMonth}-${safeProduct}-shifts.csv`);

    const pm = getProductMeta(product);
    const enrichedShifts = (generated.shifts || []).map(s => {
        const slot = pm && pm.slots[s.slotIndex];
        return {
            Date: s.date,
            Name: s.person,
            Product: product,
            SlotIndex: s.slotIndex,
            SlotKind: s.slotIndex === 0 ? 'night' : (s.slotIndex === 1 ? 'morning' : 'afternoon'),
            Start: slot ? slot.s : '',
            End: slot ? slot.e : ''
        };
    });

    const result = {
        monthLabel, product, model: claudeResp.model, allowPartialCoverage: apc,
        elapsedMs: Date.now() - t0,
        apiMs,
        usage: claudeResp.usage || {},
        generatorNotes: generated.notes || '',
        validation,
        shiftCount: generated.shifts?.length || 0,
        shifts: generated.shifts || [],
        enrichedShifts
    };
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');

    // CSV
    const csvHeader = 'Date,SlotKind,SlotIndex,Person,Start,End\n';
    const csvRows = enrichedShifts.sort((a, b) => a.Date.localeCompare(b.Date) || a.SlotIndex - b.SlotIndex)
        .map(s => [s.Date, s.SlotKind, s.SlotIndex, s.Name, s.Start, s.End].join(','))
        .join('\n');
    fs.writeFileSync(csvFile, csvHeader + csvRows, 'utf8');

    console.log('');
    console.log('[live] === HOTOVO ===');
    console.log('[live] Result:', resultFile);
    console.log('[live] CSV:   ', csvFile);
    console.log('');
    console.log('[live] Celkovy cas:', result.elapsedMs, 'ms (z toho API:', apiMs, 'ms)');
    console.log('[live] Tokeny:', claudeResp.usage?.input_tokens, 'in /', claudeResp.usage?.output_tokens, 'out');
    if (claudeResp.usage?.input_tokens) {
        const cost = (claudeResp.usage.input_tokens * 15 + (claudeResp.usage.output_tokens || 0) * 75) / 1_000_000;
        console.log('[live] Cena (Opus 4.7): ~$' + cost.toFixed(3));
    }
    console.log('[live] Validace:', validation.errors.length === 0 ? '✓ vse OK' : '✗ ' + validation.errors.length + ' chyb');
    if (validation.errors.length > 0) {
        console.log('[live] Chyby:');
        validation.errors.slice(0, 10).forEach(e => console.log('  -', e.code + ':', e.msg));
        if (validation.errors.length > 10) console.log('  ... +' + (validation.errors.length - 10) + ' dalsich');
    }
    if (validation.warnings.length > 0) {
        console.log('[live] Warnings:', validation.warnings.length);
    }
    if (generated.notes) {
        console.log('[live] Claude notes:', generated.notes);
    }
}

main().catch(e => {
    console.error('[live] CHYBA:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
