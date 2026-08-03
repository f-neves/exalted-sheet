# Exalted 2e Character Sheet

A static, self-calculating character sheet for Exalted Second Edition, covering Solar,
Abyssal, Lunar, Sidereal, Dragon-Blooded and Infernal characters.

Live: <https://f-neves.github.io/exalted-sheet/>

## How it works

Every trait is bought with experience from a **floor** defined per Exalt type. Dots up to
`max(floor, granted)` are free; everything above is charged. `granted` is the Storyteller's
concession, and it is what replaces the manual `-16` adjustment in the original
`Solar.xlsx` (Essence 3 given by the ST is now `Essence { v: 3, granted: 3 }` and costs 0).

There is no separate character-creation mode. The XP total, the budget and the remaining
balance sit in the bar at the top; overspending is allowed and simply turns red.

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

- **`castes`** — each with the `traits` it grants. For Solars, Abyssals, Sidereals and
  Dragon-Blooded those are Ability ids; for Lunars and Infernals (`favoredKind:
  "attribute"`) they are Attribute ids.
- **`favoredPicks`** — how many extra Favored traits the player may tick beyond the caste set.
- **`floors`** — the free baseline for each kind of trait.
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

- **Infernal caste Attributes are empty.** The five castes are listed with their Yozis but
  no caste Attributes, because I could not verify them against *The Manual of Exalted
  Power: Infernals*. Favored can still be ticked by hand and all XP maths is correct. Fill
  the `traits` arrays and flip `verified` to `true`.
- **Lunar, Sidereal, Dragon-Blooded and Infernal XP tables** currently carry the Solar
  numbers. Castes, aspects and Essence pools for those four are canonical.
- Charm *selection* is deliberately out of scope. Charms are a free-text list with a
  Favored checkbox; only the count drives XP.

## Development

```bash
npm install
npm run dev        # http://localhost:4321/exalted-sheet/
npm run validate   # data schema + Solar.xlsx golden test
npm run build      # validate, test, then build to dist/
```

`npm run build` runs the validator and the golden test first, so bad data cannot ship.

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
