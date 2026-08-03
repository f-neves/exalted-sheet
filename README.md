# Exalted 2e Character Sheet

A static, self-calculating character sheet for Exalted Second Edition, covering heroic
mortals plus Solar, Abyssal, Lunar, Sidereal, Dragon-Blooded and Infernal characters.

Live: <https://f-neves.github.io/exalted-sheet/>

## How it works

Every trait is bought with experience from a **floor** defined per Exalt type. Dots up to
`max(floor, granted)` are free; everything above is charged. `granted` is the Storyteller's
concession, and it is what replaces the manual `-16` adjustment in the original
`Solar.xlsx` (Essence 3 given by the ST is now `Essence { v: 3, granted: 3 }` and costs 0).

There is no separate character-creation mode. The XP total, the budget and the remaining
balance sit in the bar at the top; overspending is allowed and simply turns red.

## The cost table

`(rating)` is always the rating the character is **at**, not the one being bought. The three
rows marked · use the level being bought instead.

| | Unfavored | Favored |
| --- | --- | --- |
| Attribute | 4 × rating | 3 × rating |
| Ability (first dot) | 3 | 3 |
| Ability | 2 × rating | (2 × rating) − 1 |
| Specialty | 3 | 3 |
| Essence | — | 8 × rating |
| Charm | 10 | 8 |
| Sidereal Martial Arts | 12 | 10 |
| Other Charms | 20 | 16 |
| Spell | 2 × circle + 6 | 2 × circle + 4 |
| Astrological College (first dot) | 5 | 5 |
| Astrological College | 4 × rating | 3 × rating |
| Thaumaturgy — Degree | 10 | 8 |
| Thaumaturgy — Procedure · | 2 × level | level |
| Mutation · | 3 × level | 3 × level |
| Merit / Flaw · | 3 × bonus points | 3 × bonus points |
| Background | 3 a dot | 3 a dot |
| Mystic Background (4 to 5) | 6 a dot | 6 a dot |
| Willpower | 2 × rating | 2 × rating |
| Virtue | 3 × rating | 3 × rating |

Mutations come in four grades (1, 2, 4, 6); positive ones cost, defects refund. The same
sign rule applies to Merits and Flaws. Buying a sorcery circle spends one Charm and grants
that circle's first spell free.

Backgrounds carry a **mystic** tick that jumps them to 6 a dot at ratings 4 and 5. It is set
automatically from the list in `backgrounds.json` and can be overridden per row, which is what
Henchmen, Retainers and Spies need when the servants themselves are mystic. Sifu is the same
as Mentor; Influence is replaced by Backing and Connections; Savant is not listed.

## Starting-sheet rules

The sheet has no creation mode, so these are reported in the **Checks** panel and never block
anything. They live under `creation` in each splat file:

- Willpower must not exceed the sum of the two highest Virtues.
- At least 5 Virtue dots must be bought.
- Every favored Ability that is not a caste Ability needs at least one dot.
- The favored picks are counted against the number the type allows.

Attributes start at 2, Abilities at 0, Virtues at 1, Willpower at 5 and Essence at 2, and a
rating can never be pushed below its floor. Solars choose 5 favored Abilities beyond their
caste, Sidereals 4, Dragon-Blooded 3. Lunars always have Survival favored plus two more
Abilities, and one Attribute beyond their caste; a Casteless Lunar chooses three Attributes
instead.

Derived values are canonical Exalted 2e and every one of them shows its working on hover:

| Value | Formula |
| --- | --- |
| Dodge DV | `⌈(Dexterity + Dodge + Essence) ÷ 2⌉ − mobility penalty` |
| Parry DV | `⌈(Dexterity + weapon Ability + weapon Defense) ÷ 2⌉ − mobility penalty` |
| Mental DV | `⌈(Willpower + Integrity + Essence) ÷ 2⌉` |
| Soak | `⌊Stamina × multiplier⌋ + armour`, per damage type |
| Attack pool | `Dexterity + Ability + Accuracy + specialty − wound − fatigue` |
| Raw damage | `Strength + weapon damage` |
| Essence pools | linear coefficient maps per Exalt type |

Two things in `Solar.xlsx` were **not** copied, on purpose: its Dodge DV carried a stray
`+3`, and its "PDV" cell was a broken copy-down (`Stamina + Larceny + <empty>`). Everything
else matches the spreadsheet exactly, and `npm run validate` proves it.

## Editing the rules

All numbers live in JSON. Nothing rules-related is hardcoded in TypeScript.

```
src/data/rules.json              health track, movement, DV shapes, weapon/armour defaults,
                                 maxRating (how many dots each row draws)
src/data/attributes.json         the 9 Attributes
src/data/abilities.json          the 25 Abilities
src/data/virtues.json            the 4 Virtues
src/data/backgrounds.json        Background name suggestions (free text is still allowed)
src/data/splats/<exalt>.json     everything that differs per Exalt type
```

`src/data/splats/solar.json` is the reference file and is commented. A splat file defines:

- **`casteKind`** — what the caste grants: `"ability"` (every type except Lunars),
  `"attribute"` (Lunars), or `"none"` (heroic mortals, whose Caste selector is hidden).
- **`castes`** — each with the `traits` it grants, named by Ability or Attribute id to match
  `casteKind`.
- **`favoredAbilities`** / **`favoredAttributes`** — `{ picks, always }` each. `picks` is how
  many the player may tick freely; `always` is favored for every character of that type.
  The two are independent, which is how a Lunar holds caste Attributes, two favored
  Attributes, Survival always favored, and two more favored Abilities all at once.
- **`abilityGroups`** — the layout of the Abilities block. Omit it and the caste list is used,
  which is what every Celestial and Terrestrial sheet does. Lunars (War / Life / Wisdom) and
  mortals (Warrior / Priest / Savant / Criminal / Broker) set it explicitly.
- **`craftTypes`** — Craft carries no rating of its own. Its row in the Abilities block only
  shows the caste and favored marks; the dots live on these types, each a full Ability. The
  list is a starting point, and `+ craft type` adds more.
- **`floors`** — the free baseline for each kind of trait.
- **`maxRating`** — optional per-splat override of how many dots a row draws
  (heroic mortals cap Essence at 3).
- **`xp`** — cost of the dot that takes a trait from `n-1` to `n` is
  **`mult × (n − 1) + base`**, using the `favored` spec when the trait is caste or favored
  and `normal` otherwise. Abilities use `firstDot` / `favoredFirstDot` for the `0 → 1` step.
  Specialties, Charms, Combos and spells are flat `{ normal, favored }` costs.
- **`pools`** — linear coefficient maps. Recognised keys: `essence`, `willpower`,
  `virtuesSum`, `highestVirtue`, `twoHighestVirtues`, `lowestVirtue`, `breeding`, `flat`.
  A missing key counts as 0. Solar peripheral is `{ essence: 7, willpower: 1, virtuesSum: 1 }`,
  i.e. `Essence×7 + Willpower + sum of Virtues`.
- **`soak`** — the multiplier applied to Stamina per damage type before armour is added.
- **`limit`** — label and length of the Limit / Resonance / Torment track.
- **`sorcery.circles`** — each circle a character can initiate into. Initiating spends one
  Charm and grants that circle's first spell free.
- **`verified`** / **`_todo`** — set `verified: false` and the sheet shows a red banner
  telling the player the numbers are provisional.

Run `npm run validate` after any edit. It checks the schema, that every caste `traits`
entry names a real Ability or Attribute, that every sorcery circle has a matching XP entry,
and that the Solar numbers still reproduce the spreadsheet.

### Known gaps

- Every splat carries the same cost table, which is what the table above specifies. If a type
  ever diverges, change only that file.
- **The mortal Attribute floor is 1** (Exalted use 2) and **the mortal Charm price is a
  guess**. Both are one line each in `mortal.json`.
- **Sidereal Craft types** end in Fate, which is a guess; the other five are the elements.
- The **Astrological College list** in `sidereal.json` is a starting point, not the full
  canonical set.
- Charm *selection* is deliberately out of scope. Charms are a free-text list with a category
  and a Favored checkbox; only the category and count drive XP.

## Development

```bash
npm install
npm run dev        # http://localhost:4321/exalted-sheet/
npm run validate   # data schema + Solar.xlsx golden test
npm run build      # validate, test, then build to dist/
npm run smoke      # 40 browser checks against a running dev server
```

`npm run build` runs the validator and the golden test first, so bad data cannot ship.

`npm run smoke` drives the real page in headless Chrome and asserts the XP arithmetic,
derived values, splat switching, equipment, health and persistence all behave. It needs a
dev server plus a local Chrome and `puppeteer-core`, which is not a dependency here — point
`PUPPETEER_FROM` at a `package.json` that has it, and `CHROME_PATH` at the browser.

Pushing to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Architecture

```
src/pages/sheet.astro              the route; wires the localStorage adapter
src/components/SheetSkeleton.astro all markup and all sheet CSS (must stay `is:global`,
                                   because the engine builds DOM with innerHTML)
src/lib/engine.ts                  state, rendering, events, persistence
src/lib/calc.js                    pure formulas — no DOM, no imports, used by the
                                   browser and by scripts/test-solar.mjs alike
src/lib/data.ts                    pulls the JSON into the client bundle
```

`mountSheet()` takes its persistence as an argument:

```ts
mountSheet({
  load: () => any | null | Promise<any | null>,
  save: (state) => void,
  onReset?: () => void,
  readOnly?: boolean,
  budgetLocked?: boolean,
  budgetValue?: number | null,
});
```

so a server-backed page can reuse the engine untouched.

State is one plain object under `localStorage['exalted:sheet']`. `normalize()` in
`engine.ts` backfills and repairs anything missing, so older saves keep loading after the
shape changes. Export writes that object as JSON; **Link** base64s it into the URL hash
(`#c=…`), which `load()` reads before falling back to localStorage.
