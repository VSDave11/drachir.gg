// Vrátí null pokud je vše v pořádku, jinak chybovou hlášku (string).
// Brání rozbití server-side template literalu zpětnou uvozovkou nebo ${ .
function validateNoTemplateChars(...values) {
    for (const v of values) {
        if (typeof v !== 'string') continue;
        if (v.includes('`') || v.includes('${')) {
            return 'Neplatný znak: hodnota nesmí obsahovat zpětnou uvozovku (`) ani ${';
        }
    }
    return null;
}

module.exports = { validateNoTemplateChars };
