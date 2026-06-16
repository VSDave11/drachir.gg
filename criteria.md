# Kritéria pro AI generátor rozvrhu

Tento soubor obsahuje VŠECHNA kritéria, podle kterých má AI generátor vytvářet měsíční rozvrhy.

**Jak to funguje:**
- Tento soubor je zdrojem pravdy pro generator. Hardcoded pravidla v `index.js` jsou jen technické (H1-H8 = ochrana proti porušení handover času, atd.).
- Vše, co je business-pravidlo (kdo nedělá noční, kdo radši víkendy, sezónní výjimky), patří sem.
- Až bude soubor naplněný, `buildGeneratorPrompt` jeho obsah vloží do system promptu jako `ADDITIONAL_CUSTOM_RULES`.
- Když chceš pravidlo změnit, edituj zde — žádný redeploy, generator si to přečte při dalším volání.

**Jak psát pravidla:**
- Píš v jednoduchých větách. AI rozumí lidsky.
- Konkrétní jména, čísla, dny — ne obecné formulace.
- Příklad dobrý: "Marek M. nikdy nedělá noční směny." Příklad špatný: "Někteří lidé by neměli mít noční."
- Pokud má pravidlo výjimky, popiš je hned.
- Buď stručný — víc pravidel = větší prompt = vyšší cena za API volání. Současný prompt je ~9k tokenů, criteria.md by neměl přidat víc než ~3-5k.

---

## 1. Lidé a skupiny

Aktuální `peopleHierarchy` (z `index.js` ř. 479):

| Skupina | Týdenní target | Členové |
|---|---|---|
| Head of Trading - eSims | 0h | David Winkler |
| Quality Assurance | 16h | Ondřej Merxbauer |
| Master Scheduler | 24h | David Kuchař |
| Team Leaders | 20h | Lukáš Novotný, Filip Sklenička, Jindřich Lacina, David Trocino, David Lamač, Tomáš Komenda, Dominik Chvátal, Marcelo Goto |
| Title Experts | 24h | Adam Zach, Andrej Rybalka, Ivan Čitári, Jan Bouška, Jan Kubelka, Matěj Kos, Ladislav Bánský, Richard Mojš, Robert Šobíšek, Vojtěch Malár, Benjamin Drzymalla, Patrik Říčka, Martin Jílek |
| Traders - Europe | 40h | Denis M., Ivan, Jakub K., Jan K., Jiří K., Lukáš T., Marek M., Martin N., Matyáš P., Michal F., Michal P., Michal W., Petr H., Petr R., Przemyslaw K., Sebastián W., Stanislav U., Tadeáš F., Tomáš M., Viet |
| Traders - Lima | 40h | Adrian M., Andres, Christian C., David Z., Flabio T., Francesco, Franco M., Gustavo P., Hadi B., James H., Jose C., Martin M. M., Santiago B., William M., Kevin R. |

**Sjednocená jména** (alias mapping v `PERSON_ALIASES`):
- Robert Š. → Robert Šobíšek
- Ladislav B. → Ladislav Bánský
- Przemek → Przemyslaw K.

**TODO — chybějící lidé / korekce?**
- (sem napiš lidi, kteří byli zapomenuti nebo by se měli změnit)

---

## 2. Produkty a coverage

Aktuální `productMapping` (z `index.js` ř. 489) — slot časy:

| Produkt | Noční | Ranní | Odpolední |
|---|---|---|---|
| Valhalla Cup A | 22:55–06:44 | 06:55–14:48 | 14:55–22:47 |
| Valhalla Cup B | 22:57–06:46 | 06:57–14:50 | 14:57–22:49 |
| Valhalla Cup C | 00:04–08:04 | 08:04–16:04 | 16:04–00:04 |
| Valkyrie Cup A | 22:40–06:22 | 06:40–14:32 | 14:40–22:32 |
| Valkyrie Cup B | 22:42–06:24 | 06:42–14:34 | 14:42–22:34 |
| Valhalla League (NBA) | 23:40–07:44 | 08:00–16:00 | 16:00–23:40 |
| Yodha League (Cricket) | 23:00–07:00 | 07:00–15:00 | 15:00–23:00 |
| CS 2 Duels | 00:00–08:00 | 08:00–16:00 | 16:00–00:00 |
| Dota 2 Duels | 00:01–08:00 | 08:00–16:00 | 16:00–00:01 |
| Madden | 23:10–07:10 | 07:10–15:10 | 15:10–23:10 |

Coverage profil (kdy běží — `productCoverage` v `index.js` ř. 746):
- **Default = 24/7** (všechny 3 sloty, každý den): Cricket, NBA, FIFA cupy, Duels, Madden
- **Table Tennis**: 24/7
- **World of Tanks**: jen ranní (slot 1) v pondělí-pátek
- **eHockey**: ranní + odpolední (sloty 1+2), každý den

**TODO — chceš změnit coverage pro některý produkt?**
- (sem napiš změny)

---

## 3. HARD pravidla (současná — H1 až H8)

**Nikdy se neporušují, validator je vynucuje:**

- **H1**: Pouze sloty/dny definované v coverage profilu.
- **H2**: Přiřazená osoba MUSÍ být v eligible listu (Capabilities sheet).
- **H3**: Osoba NESMÍ mít Vacation/RIP záznam ten den.
- **H4**: Osoba NESMÍ dělat ranní (slot 1) A noční (slot 0) stejný kalendářní den.
- **H5**: Osoba NESMÍ dělat víc než 7 dní v řadě.
- **H6**: Osoba NESMÍ být na jiném produktu stejný den.
- **H7**: Osoba NESMÍ dělat noční den X A ranní den X+1 (handover ~11 min).
- **H8**: Osoba NESMÍ dělat odpolední A noční stejný kalendářní den (handover ~8 min).

### Vlastní HARD pravidla (přidat dle potřeby)

Příklad:
- **H9**: Pokud má někdo víkend Sa+Ne, musí mít volno celý pondělí (regenerace po víkendu).
- **H10**: Jeden Lima trader vždy musí být na nočních Cup A v rámci stejného týdne.

**TODO — sem napiš svá vlastní HARD pravidla:**
- **H9**: Team Leaders, Title Experti, QA a Scheduler master = ŽÁDNÉ noční směny, nikdy. (Implementováno v solveru `NO_NIGHT_GROUPS`.)
- **H10**: STRICT weekly target cap = max shifts per week = floor(weeklyTarget/8). Andrej Rybalka (TE 24h) = max 3 shifts/týden, Lima/Europe Trader (40h) = max 5 shifts/týden, TL (20h) = max 2 shifts/týden, QA (16h) = max 2 shifts/týden, Head of Trading (0h) = 0 shifts. **Nepřekračovat bez ohledu na kapacity.** (Implementováno v solveru `personWeeklyShifts`.)
- **H11**: Europe (Czech) Traders MOHOU dělat noční, pokud Lima Traders nestačí. Tj. noční Cup A/B/... = primárně Lima, sekundárně Europe. Žádné omezení — Europe nights povoleny.

---

## 4. SOFT pravidla (současná — S1 až S4)

**Generator se snaží dodržet, ale občas porušit OK:**

- **S1**: ~~Týdenní hodiny v rozsahu ±8h od targetu~~ — **NAHRAZENO H10** (strict weekly cap, viz §3). S1 je teď redundantní.
- **S2**: Min 7h pauza mezi odpolední → ranní následujícího dne.
- **S3**: Max 70% víkendových slotů per osoba.
- **S4**: Lima a Europe rozdělit víkendy roughly rovnoměrně.

### Vlastní SOFT pravidla (přidat dle potřeby)

Příklad:
- **S5**: Pokud možno střídat sloty (= jeden člověk neměl by 5 nočních za sebou na různých produktech).
- **S6**: Title Experts radši dělat odpolední než noční.

**TODO — sem napiš svá vlastní SOFT pravidla:**
- S5 za me supr nápad

---

## 5. Preference lidí (individuální výjimky)

Pro každou osobu, která má specifické preference nebo omezení, napiš jeden bod.
**Tato pravidla jsou SOFT (generator se snaží dodržet, ne hard).**

Příklad:
- **Lukáš Novotný**: Preferuje ranní směny, nedělá noční (s výjimkou krizových situací).
- **Adam Zach**: Studuje, preferuje weekend.
- **Tomáš Komenda**: Nedělá pondělí (volno na vyzvedávání dětí).
- **Jose C.**: Lima časové pásmo — ideální na noční Europe (jeho ranní = europe noc).

**TODO — sem napiš preference jednotlivých lidí:**
- Jose prefetuje pouze noční smeny
- Michal F. chce pouze odpolední směny
- Jan K. nikdy ranní v úterý


---

## 6. Cross-product strategie

Jak rozdělit lidi mezi produkty.

Příklad současné praxe (z Claude pozorování):
- **Lima trader (Jose C., David Z.)** na nočních Cup A (timezone fit)
- **Europe trader** rozdělit na ranní + odpolední napříč produkty
- **Title Experts** lehčí produkty (Cup B/C, Valkyrie)
- **Team Leaders** podpůrné role, kratší týden, méně směn celkem

**TODO — chceš nastavit vlastní cross-product strategii?**

**Priority pořadí kandidátů** (implementováno v `lib/local-solver.js` ve `scoreCandidate`):
1. **Traders (Europe + Lima)** — nejvyšší priorita. Dokud nemají naplněno svých 5 shifts/týden, dostávají směny.
2. **Head of Trading** (David Winkler) — má target=0, takže je v praxi vyřazen; v solveru jako tier 2.
3. **Title Experts, Team Leaders, QA, Master Scheduler** — fallback. Solver je sáhne až když všichni Traders jsou saturovaní pro daný (týden + slot).

**Důsledek:** TE/TL/QA budou pravděpodobně mít méně směn v měsíci, než je jejich target (24h pro TE, 20h pro TL, 16h pro QA). To je záměr — Traders jsou priorita.

**Strategie nočních směn (per H9 + H11):**
- Lima Traders primárně (timezone fit)
- Europe Traders sekundárně (když Lima nestačí — typický scénář v dovolenkové sezóně)
- TE/TL/QA/Scheduler NIKDY (H9 hard ban)

---

## 7. Speciální dny a období

Svátky, sezónní výjimky, eventy, kdy je potřeba víc/méně lidí.

Příklad:
- **Státní svátky** (1.5., 8.5., 5.7., 6.7., 28.9., 28.10., 17.11., 24.-26.12.): zredukovaný provoz, méně lidí na ranních směnách
- **Vánoce 24.-26.12.**: jen kritická pokrytí, ostatní volno
- **NHL playoff (duben-červen)**: víc lidí na Valhalla League noční
- **Letní prázdniny (červenec-srpen)**: očekávat hodně dovolených, allowPartialCoverage=true

**TODO — sem napiš speciální pravidla:**
-

---

## 8. Párovací pravidla (kdo s kým / kdo bez koho)

Pokud jsou v týmu dynamiky (junior + senior, mentorování, konflikty), popiš tady.

Příklad:
- **Junior + Senior pair**: Jan Kubelka (junior) musí dělat noční vždy s Lukášem T. (mentor).
- **Konflikt**: Marek M. a Jakub K. nepracují stejný den (komunikační problémy).

**TODO — sem napiš párovací pravidla:**
-

---

## 9. Corner cases / poznámky

Cokoli, co se nehodí do předchozích sekcí.

Příklad:
- Pokud někdo má nestandardní úvazek (např. DPP 12h/týden místo standardních 40h), poznamenej tady.
- Pokud máš pravidlo "v sobotu odpoledne musí být alespoň 2 lidi na Cup A" — sem.

**TODO:**
-

---

## Hot reload

Tento soubor se čte při každém volání `/api/generate-schedule` (= žádný restart serveru potřeba). Změny vidíš okamžitě v dalším GENERATE.

Pokud se prompt zvětší příliš (přes ~20k tokenů), uvidíš to ve výstupu modalu. Pak zvaž zkrácení nebo přesun části pravidel do hardcoded validatoru.

---

## Verzování

Tento soubor je v gitu. Když uděláš změny, commit + push, aby tým viděl historii pravidel. Doporučená commit message:

```
criteria: <stručně co se změnilo>

Příklad: Přidáno pravidlo H9 — víkend Sa+Ne = volno pondělí (regenerace).
```
