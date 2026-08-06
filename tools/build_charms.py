"""Turn the Exalted 2e charm PDFs into the JSON the sheet loads.

    python tools/build_charms.py <folder with the PDFs>

Writes public/charms/: an index, one compact file per set (what the picker
lists) and one text file per set (the prose, fetched only when a charm is
opened). Nothing here runs at build time or in the browser; the output is
committed, so the PDFs are only needed to regenerate it.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import charm_books
import charm_lists
from charm_common import clean, fields, slug, titlecase

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'charms')
DATA = os.path.join(ROOT, 'src', 'data')

SETS = [
    {'id': 'solar', 'name': 'Solar Charms', 'kind': 'native', 'splat': 'solar'},
    {'id': 'abyssal', 'name': 'Abyssal Charms', 'kind': 'native', 'splat': 'abyssal'},
    {'id': 'lunar', 'name': 'Lunar Charms and Knacks', 'kind': 'native', 'splat': 'lunar'},
    {'id': 'sidereal', 'name': 'Sidereal Charms', 'kind': 'native', 'splat': 'sidereal'},
    {'id': 'dragon-blooded', 'name': 'Dragon-Blooded Charms', 'kind': 'native',
     'splat': 'dragon-blooded'},
    {'id': 'infernal', 'name': 'Infernal Charms', 'kind': 'native', 'splat': 'infernal'},
    {'id': 'ma-terrestrial', 'name': 'Terrestrial Martial Arts', 'kind': 'martial-arts',
     'tier': 'terrestrial'},
    {'id': 'ma-celestial', 'name': 'Celestial Martial Arts', 'kind': 'martial-arts',
     'tier': 'celestial'},
    {'id': 'ma-sidereal', 'name': 'Sidereal Martial Arts', 'kind': 'martial-arts',
     'tier': 'sidereal'},
]

ABILITIES = json.load(open(os.path.join(DATA, 'abilities.json'), encoding='utf-8'))
ATTRIBUTES = json.load(open(os.path.join(DATA, 'attributes.json'), encoding='utf-8'))
BY_NAME = {a['name'].lower(): ('ability', a['id']) for a in ABILITIES}
BY_NAME.update({a['name'].lower(): ('attribute', a['id']) for a in ATTRIBUTES})

TRAIT_RE = re.compile(
    r'\b(' + '|'.join(sorted((re.escape(n) for n in BY_NAME), key=len, reverse=True))
    + r'|Essence|\(Ability\)|\(Attribute\)|\(Yozi\))\s*(\d+)', re.I)


def parse_mins(text):
    """"Melee 4, Essence 3" -> {'traits': {'melee': 4}, 'essence': 3}."""
    out = {'traits': {}}
    for m in TRAIT_RE.finditer(text or ''):
        word, n = m.group(1).lower(), int(m.group(2))
        if word == 'essence':
            out['essence'] = n
        elif word in ('(ability)', '(attribute)', '(yozi)'):
            out['any'] = n
        elif word in BY_NAME:
            out['traits'][BY_NAME[word][1]] = n
    if not out['traits']:
        out.pop('traits')
    return out


def tree_of(set_id, charm):
    """Display name, grouping and linked trait for the tree a charm belongs to."""
    group = titlecase(charm['group']) if charm['group'] else None
    raw = charm['tree']
    section = charm['section'] or ''

    if set_id == 'infernal':
        name, sub, trait = group or 'General Charms', None, None
        group = None
    elif set_id.startswith('ma-'):
        name, sub, trait = titlecase(raw or 'Other'), None, ('ability', 'martial-arts')
        group = None
    elif set_id == 'sidereal':
        if not raw:
            name, sub, trait, group = group or 'General Charms', None, None, None
        else:
            head, _, tail = raw.partition(':')      # "RESISTANCE: THE MAST"
            name, sub = titlecase(head), titlecase(tail) or None
            trait = BY_NAME.get(name.lower())
    elif set_id == 'lunar':
        if 'KNACK' in section:
            name, sub, trait, group = titlecase(raw or 'Knacks'), None, None, 'Shifting Knacks'
        else:
            # Charms sit under an Attribute, split into themed groups below it.
            name = re.sub(r'\s+Charms$', '', titlecase(raw)) if raw else (group or 'General Charms')
            sub, trait = None, BY_NAME.get((group or '').lower())
    else:
        name = titlecase(raw) if raw else (group or 'General Charms')
        sub, trait = None, BY_NAME.get(name.lower())

    name = name or 'General Charms'
    return name, sub, (None if group == name else group), trait


def build(directory):
    os.makedirs(OUT, exist_ok=True)
    index, report = [], []

    for meta in SETS:
        sid = meta['id']
        if sid == 'ma-sidereal':
            raw = charm_books.parse(directory, 'ma-sidereal')
        else:
            raw = charm_lists.parse(directory, sid)
            if sid == 'sidereal':
                # The compiled Sidereal list is missing one whole tree.
                extra = charm_books.parse(directory, 'sidereal-sword')
                raw += [c for c in extra if (c['tree'] or '').startswith('MARTIAL ARTS')]

        trees, charms, used, dropped = {}, [], {}, 0
        for c in raw:
            f = fields(c['statText'])
            if 'Mins' not in f and 'Prerequisite Charms' not in f:
                dropped += 1
                continue                       # a sidebar, not a charm

            name, sub, group, trait = tree_of(sid, c)
            tid = slug((group + ' ' + name) if group and sid == 'lunar' else name)
            if tid not in trees:
                trees[tid] = {'id': tid, 'name': name, **({'sub': sub} if sub else {}),
                              **({'group': group} if group else {}),
                              **({'trait': trait[1], 'traitKind': trait[0]} if trait else {})}

            title = titlecase(c['name'])
            cid = slug(title)
            used[cid] = used.get(cid, 0) + 1
            if used[cid] > 1:
                cid = f'{cid}-{used[cid]}'

            mins = parse_mins(f.get('Mins', '') or f.get('Prerequisite Charms', ''))
            row = {'id': cid, 'n': title, 't': tid}
            if mins:
                row['min'] = mins
            for key, field in (('cost', 'Cost'), ('type', 'Type'), ('kw', 'Keywords'),
                               ('dur', 'Duration'), ('pre', 'Prerequisite Charms')):
                v = clean(f.get(field, ''))
                if v and v.lower() not in ('none', '—', '-'):
                    row[key] = v
            if c['source']:
                row['src'] = clean(c['source'])
            row['p'] = c['page']
            row['_text'] = c['text']
            charms.append(row)

        # Link prerequisites to charms in the same set, for the "missing prerequisite" note.
        by_name = {}
        for row in charms:
            by_name.setdefault(row['n'].lower(), row['id'])
        for row in charms:
            pre = row.get('pre')
            if not pre:
                continue
            low = pre.lower()
            hits = [cid for nm, cid in by_name.items()
                    if len(nm) > 6 and nm in low and cid != row['id']]
            if hits:
                row['preIds'] = sorted(set(hits))

        text = {row['id']: row.pop('_text') for row in charms}
        payload = {k: v for k, v in meta.items()}
        payload['trees'] = list(trees.values())
        payload['charms'] = charms

        with open(os.path.join(OUT, f'{sid}.json'), 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(OUT, f'{sid}.text.json'), 'w', encoding='utf-8') as fh:
            json.dump({k: v for k, v in text.items() if v}, fh, ensure_ascii=False,
                      separators=(',', ':'))

        index.append({**meta, 'count': len(charms), 'trees': len(trees)})
        size = os.path.getsize(os.path.join(OUT, f'{sid}.json')) // 1024
        tsize = os.path.getsize(os.path.join(OUT, f'{sid}.text.json')) // 1024
        report.append(f'{sid:16s} {len(charms):4d} charms  {len(trees):3d} trees  '
                      f'{size:4d} KB + {tsize:4d} KB text  ({dropped} non-charm entries skipped)')

    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump({'version': 1, 'sets': index}, fh, ensure_ascii=False, indent=1)

    print('\n'.join(report))
    print(f'TOTAL {sum(s["count"] for s in index)} charms in {len(index)} sets -> {OUT}')


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'ajustes'))
