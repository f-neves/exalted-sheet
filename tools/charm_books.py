"""Read charms out of the full rulebooks, where no compiled list exists.

Two things live only here: the seven Sidereal martial arts (Scroll of the Monk,
chapter four) and the Sidereal "Martial Arts: The Sword" tree, which the compiled
Sidereal list leaves out. The books are laid out as books rather than as lists,
but the charm entries themselves are regular: the name is set in Missive at
heading size, the stat block is the bold body face with one field per line, and
the prose that follows starts with a first-line indent.
"""
import os
import re

import fitz

from charm_common import (STAT_START, PREREQ_RE, span_text, columns, place, join_lines)

RUNNING_HEAD = re.compile(r'^CHAPTER\b|•')

# file, page range (1-based, inclusive), body size, name size, tree size, group size
BOOKS = {
    'ma-sidereal': ('Scrolls of Esoteric Wisdom Vol. 1 - Scroll of the Monk.pdf',
                    113, 152, 9.9, 14.0, 17.0, None),
    'sidereal-sword': ('The Manual of Exalted Power - Sidereals.pdf',
                       182, 186, 10.0, 14.0, 17.0, 22.0),
}


def read(pdf, first, last, body):
    out = []
    for pno in range(first - 1, last):
        page = []
        for b in pdf[pno].get_text('dict')['blocks']:
            for l in b.get('lines', []):
                spans = [s for s in l['spans'] if s['text'].strip()]
                if not spans:
                    continue
                page.append({
                    'page': pno + 1, 'x': round(l['bbox'][0]), 'y': l['bbox'][1],
                    'size': round(max(s['size'] for s in spans), 1),
                    'font': spans[0]['font'],
                    'text': span_text(spans),
                })
        cols = columns(page, body)
        for l in page:
            l['col'], l['indent'] = place(l, cols)
        page.sort(key=lambda r: (r['col'], r['y']))
        seen = set()
        for l in page:
            key = (l['x'], round(l['y']), l['text'])
            if key in seen:
                continue            # these books draw some headings twice
            seen.add(key)
            out.append(l)
    return out


def parse(directory, key):
    path, first, last, body, name_size, tree_size, group_size = BOOKS[key]
    lines = read(fitz.open(os.path.join(directory, path)), first, last, body)

    def near(v, target):
        return target is not None and abs(v - target) < 0.6

    charms, cur = [], None
    tree = group = pending = state = None

    def flush():
        nonlocal pending, tree, group, cur, state
        if pending is None:
            return
        kind, text = pending
        if kind == 'group':
            group, tree = text, None
        else:
            tree = text
        cur, state, pending = None, None, None

    for l in lines:
        t, size = l['text'], l['size']
        kind = None
        if 'Missive' in l['font'] or 'Albertus' in l['font']:
            kind = ('group' if near(size, group_size) else
                    'tree' if near(size, tree_size) else None)
        if kind:
            if pending and pending[0] == kind:
                pending = (kind, pending[1] + ' ' + t)   # a heading that wrapped
            else:
                flush()                                  # a heading of another level follows
                pending = (kind, t)
            continue
        flush()

        if 'Missive' in l['font'] and near(size, name_size):
            if RUNNING_HEAD.search(t):
                continue                        # running header at the foot of the page
            if cur is not None and state == 'name':
                cur['name'] += ' ' + t          # a name that wrapped
                continue
            cur = {'name': t, 'section': None, 'group': group, 'tree': tree,
                   'page': l['page'], 'source': None, 'stat': [], 'desc': []}
            charms.append(cur)
            state = 'name'
            continue

        if cur is None or abs(size - body) > 0.6:
            continue
        if state == 'name':
            state = 'stat' if STAT_START.match(t) else 'desc'
        if state == 'stat':
            joined = ' '.join(cur['stat'])
            m = PREREQ_RE.search(joined)
            if l['indent'] and (bool(m and joined[m.end():].strip()) or len(cur['stat']) > 40):
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
