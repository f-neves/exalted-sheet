# Charm extraction

`public/charms/` is generated from the Exalted 2e PDFs by the scripts in this folder. The
output is committed, so nothing here runs at build time or in the browser, and the PDFs are
needed only when the lists are regenerated.

**The PDFs are not in this repository** and must not be: they are the published books. Point
the script at wherever you keep them.

```bash
pip install pymupdf
python tools/build_charms.py "/path/to/the/pdfs"
npm run validate            # proves the generated files still hang together
```

## What comes from where

| Set | Source |
| --- | --- |
| `solar`, `abyssal`, `lunar`, `sidereal`, `dragon-blooded`, `infernal` | the compiled charm lists, files 02–07 |
| `ma-terrestrial`, `ma-celestial` | the compiled charm lists, files 08–09 |
| `ma-sidereal` | *Scroll of the Monk*, chapter four |
| the Sidereal **Martial Arts: The Sword** tree | *MoEP: Sidereals*, pp. 182–186 |

That last row is a patch, not a preference: the compiled Sidereal list has 24 of the 25
Ability trees and silently omits Martial Arts. Without it a Sidereal sheet would be missing
twelve Charms with no sign that anything was gone.

## How the parsing works

Every one of these PDFs, list or book, lays a charm out the same way:

```
CHARM NAME IN CAPITALS          <- bold (lists) or Missive (books), at body size
Corebook (Modified)             <- italic source line, lists only
Cost: 1m; Mins: Melee 2, ...    <- the stat block
    Solar warriors make them…   <- prose, and it always starts with a first-line indent
```

So the parsers key on three things, all of which survive the differences between the files:

1. **Heading size.** Each file declares which point sizes mean section, group and tree.
   A heading that wraps over two lines is joined; a heading of another level flushes the one
   before it.
2. **The indent.** The stat block ends at the first indented line after the prerequisite
   field has a value. Indentation alone will not do, because a justified stat block comes out
   of the PDF one word per line with every word "indented".
3. **Column geometry, per page.** Not the page midpoint: several pages set their right column
   a few points left of centre, and getting this wrong silently interleaves two charms.

Things that are handled because they were found breaking the output: ligature glyphs that
extract with a stray space (`inﬂ ict`), soft hyphens from justification (`Re-` + `plenishment`
is one word, `Hauberk-` + `Lightening` is two), small-caps headings that drop the space before
`OF` and `AND`, running headers that look like charm names, and pages the PDF draws twice.

## What is dropped, and why

`build_charms.py` keeps an entry only if it has a `Mins` or a `Prerequisites` field. That
removes the sidebars set in the same face as charm names — *Destiny and the Arbiters*, the
Crimson Pentacle Blade postures, *What's the Secret?* — and the count of what it skipped is
printed per set so a change in that number is visible.

One real charm is known to be lost: **Graceful Tortoise Technique** (Crimson Pentacle Blade
Style) has its name at the foot of one column and its stat block on the next page, which the
reading order cannot bridge. Add it by hand with **+ by name** if you need it.

## The output

```
public/charms/index.json        the sets, their kind, and their counts
public/charms/<set>.json        trees and charms: name, tree, minimums, cost, type,
                                keywords, duration, prerequisites, book and page
public/charms/<set>.text.json   the rules text, keyed by charm id
```

Charm ids are slugs of the name and are what a saved sheet stores, so **renaming a charm
breaks the sheets that hold it**. `npm run validate` checks that ids are unique, that every
charm sits in a tree that exists, that every tree names a real Ability or Attribute, and that
every resolved prerequisite points at a charm in the same set.
