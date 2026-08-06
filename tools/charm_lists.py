"""Read the eight compiled Exalted 2e charm-list PDFs.

They are all laid out the same way, only the fonts and heading sizes change:
a two-column body, headings a few points larger and bold, and each charm opening
with a bold ALL-CAPS name, an italic source line, and a "Cost: ...; Mins: ...;"
stat block. The prose that follows always starts with a first-line indent, which
is how the end of the stat block is found.
"""
import os
import re
import collections

import fitz

from charm_common import (STAT_START, PREREQ_RE, FIELD_RE, clean, span_text,
                          columns, place, join_lines)

UPPER = re.compile(r'[A-Z]')

# file, then the heading sizes that mean section / group / tree
LISTS = {
    'solar':          ('Exalted 2ed - Charm List - 02 - Solar.pdf',       [24.0], [22.1], [13.9]),
    'lunar':          ('Exalted 2ed - Charm List - 03 - Lunar.pdf',       [24.0], [22.1, 19.9], [13.9]),
    'sidereal':       ('Exalted 2ed - Charm List - 04 - Sidereal.pdf',    [24.0], [21.8, 20.3], [14.3]),
    'dragon-blooded': ('Exalted 2ed - Charm List - 05 - Terrestrial.pdf', [24.0], [22.1], [13.9]),
    'abyssal':        ('Exalted 2ed - Charm List - 06 - Abyssal.pdf',     [24.0], [21.8], [14.3]),
    'infernal':       ('Exalted 2ed - Charm List - 07 - Infernal.pdf',    [24.0], [21.8, 20.3], []),
    'ma-terrestrial': ('Exalted 2ed - Charm List - 08 - Martial Arts - Terrestrial.pdf',
                       [24.0], [], [15.8, 14.3, 20.3]),
    'ma-celestial':   ('Exalted 2ed - Charm List - 09 - Martial Arts - Celestial.pdf',
                       [24.0], [], [16.0, 22.0]),
}


def read(pdf):
    pages = []
    for pno, p in enumerate(pdf):
        page = []
        for b in p.get_text('dict')['blocks']:
            for l in b.get('lines', []):
                spans = [s for s in l['spans'] if s['text'].strip()]
                if not spans:
                    continue
                page.append({
                    'page': pno + 1, 'x': round(l['bbox'][0]), 'y': l['bbox'][1],
                    'size': round(max(s['size'] for s in spans), 1),
                    'bold': all('Bold' in s['font'] for s in spans),
                    'italic': all('Italic' in s['font'] for s in spans),
                    'text': span_text(spans),
                })
        pages.append(page)

    body = collections.Counter(l['size'] for pg in pages for l in pg).most_common(1)[0][0]
    out = []
    for page in pages:
        cols = columns(page, body)
        for l in page:
            l['col'], l['indent'] = place(l, cols)
        page.sort(key=lambda r: (r['col'], r['y']))
        out += page
    return out, body


def is_name(line, body):
    if not line['bold'] or abs(line['size'] - body) > 0.3:
        return False
    t = line['text']
    if FIELD_RE.match(t) or t.startswith('Charms:'):
        return False
    letters = [c for c in t if c.isalpha()]
    if not letters or not UPPER.search(t):
        return False
    return sum(1 for c in letters if c.isupper()) / len(letters) > 0.85


def parse(directory, key):
    path, secs, groups, trees = LISTS[key]
    lines, body = read(fitz.open(os.path.join(directory, path)))

    def near(size, bucket):
        return any(abs(size - b) < 0.4 for b in bucket)

    charms, cur = [], None
    section = group = tree = None
    pending, state = None, None

    def flush():
        nonlocal pending, section, group, tree, cur, state
        if pending is None:
            return
        kind, text = pending
        text = clean(text)
        if kind == 'section':
            section, group, tree = text, None, None
        elif kind == 'group':
            group, tree = text, None
        else:
            tree = text
        cur, state, pending = None, None, None

    for l in lines:
        t, size = l['text'], l['size']
        kind = None
        if l['bold'] and size > body + 1.0:
            kind = ('section' if near(size, secs) else
                    'group' if near(size, groups) else
                    'tree' if near(size, trees) else None)
        if kind:
            if pending and pending[0] == kind:
                pending = (kind, pending[1] + ' ' + t)   # a heading that wrapped
            else:
                flush()                                  # a heading of another level follows
                pending = (kind, t)
            continue
        flush()

        if t.isdigit() or abs(size - body) > 2.5:
            continue                                  # page numbers and other furniture

        if is_name(l, body):
            if cur is not None and state == 'name':
                cur['name'] += ' ' + t                # a name that wrapped
                continue
            cur = {'name': t, 'section': section, 'group': group, 'tree': tree,
                   'page': l['page'], 'source': None, 'stat': [], 'desc': []}
            charms.append(cur)
            state = 'name'
            continue

        if cur is None:
            continue
        if state == 'name':
            if l['italic'] and cur['source'] is None:
                cur['source'] = t
                continue
            state = 'stat' if STAT_START.match(t) else 'desc'
        if state == 'stat':
            # A justified stat block comes out of the PDF one word per line, every
            # word "indented", so indentation alone cannot mark its end. The block
            # is over once the prerequisite field has a value and prose resumes.
            joined = ' '.join(cur['stat'])
            m = PREREQ_RE.search(joined)
            if l['indent'] and (bool(m and joined[m.end():].strip()) or len(cur['stat']) > 60):
                state = 'desc'
            else:
                cur['stat'].append(t)
                continue
        cur['desc'].append(t)

    flush()
    for c in charms:
        c['statText'] = join_lines(c.pop('stat'))
        c['text'] = join_lines(c.pop('desc'))
    return charms
