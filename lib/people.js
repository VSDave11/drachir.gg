// Čistá transformace: řádky listu People + definice skupin -> datové struktury.
// Lima se odvozuje z členství ve skupině limaLabel.
function buildPeopleStructures(rows, groups, limaLabel = 'Traders - Lima') {
    const validGroups = new Set(groups.map(g => g.label));
    const membersByGroup = {};
    const personColors = {};
    const limaSet = new Set();
    const warnings = [];

    for (const r of (rows || [])) {
        const name = (r.Name || '').toString().trim();
        const group = (r.Group || '').toString().trim();
        const color = (r.Color || '').toString().trim();
        if (!name) continue;
        if (!validGroups.has(group)) {
            warnings.push('Neznama skupina "' + group + '" u osoby "' + name + '" - vynechana');
            continue;
        }
        if (!membersByGroup[group]) membersByGroup[group] = [];
        membersByGroup[group].push(name);
        personColors[name] = color || '#888';
        if (group === limaLabel) limaSet.add(name);
    }

    const peopleHierarchy = groups.map(g => ({
        label:   g.label,
        color:   g.color,
        target:  g.target,
        members: membersByGroup[g.label] || []
    }));

    return { peopleHierarchy, personColors, limaSet, warnings };
}

module.exports = { buildPeopleStructures };
