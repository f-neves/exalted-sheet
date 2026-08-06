"""Shared helpers for reading the Exalted 2e charm PDFs.

Not part of the site. See tools/README.md for how the data under public/charms
is regenerated, and why the PDFs themselves are not in this repository.
"""
import collections
import re
import unicodedata

# The PDFs use ligature glyphs and the extractor sees a stray space after them.
LIGATURES = [('ﬃ ', 'ffi'), ('ﬄ ', 'ffl'), ('ﬁ ', 'fi'), ('ﬂ ', 'fl'), ('ﬀ ', 'ff'),
             ('ﬃ', 'ffi'), ('ﬄ', 'ffl'), ('ﬁ', 'fi'), ('ﬂ', 'fl'), ('ﬀ', 'ff')]

FIELDS = ['Cost', 'Mins', 'Type', 'Keywords', 'Duration',
          'Prerequisite Charms', 'Prerequisite Charm', 'Prerequisites', 'Prerequisite']
FIELD_RE = re.compile(r'\b(' + '|'.join(re.escape(f) for f in FIELDS) + r')\s*:\s*')
PREREQ_RE = re.compile(r'Prerequisites?(\s+Charms?)?\s*:')
STAT_START = re.compile(r'^(Cost|Mins|Prerequisites?)\s*:')


def clean(text):
    for a, b in LIGATURES:
        text = text.replace(a, b)
    return ' '.join(text.split())


def span_text(spans):
    """Join a line's spans.

    Small-caps headings drop the space in front of words like OF and AND, because
    those words are a separate, smaller span. Two adjacent spans of the same size
    are therefore two words, and need the space put back.
    """
    out, prev = '', None
    for s in spans:
        t = s['text']
        if (prev is not None and abs(s['size'] - prev) < 0.2 and out
                and not out.endswith(' ') and not t.startswith(' ')
                and out[-1].isalpha() and t[:1].isalpha()):
            out += ' '
        out += t
        prev = s['size']
    return clean(out)


def columns(page_lines, body):
    """Left margin of each text column on a page.

    Not simply the page's midpoint: some pages set their right column a little
    left of centre, and every column has a first-line indent about 14pt in.
    """
    xs = collections.Counter(l['x'] for l in page_lines if abs(l['size'] - body) < 0.35)
    keep = sorted(x for x, n in xs.items() if n >= 3)
    if not keep:
        return [0]
    cols, run = [], [keep[0]]
    for x in keep[1:]:
        if x - run[-1] > 40:
            cols.append(run[0])
            run = []
        run.append(x)
    cols.append(run[0])
    return cols


def place(line, cols):
    """Which column a line sits in, and whether it is indented from that margin."""
    i = 0
    for j, c in enumerate(cols):
        if line['x'] >= c - 2:
            i = j
    return i, line['x'] > cols[i] + 4


def join_lines(parts):
    """Undo the line breaks, healing words the justification split with a hyphen.

    A trailing hyphen followed by a lowercase letter is a soft break ("Re-" +
    "plenishment"); followed by a capital it is a real compound ("Hauberk-" +
    "Lightening").
    """
    out = ''
    for p in parts:
        if not out:
            out = p
        elif out.endswith('-') and p[:1].isalpha():
            out = (out[:-1] if p[:1].islower() else out) + p
        else:
            out += ' ' + p
    return out


def fields(stat):
    """Cut a stat block into its labelled fields."""
    hits = list(FIELD_RE.finditer(stat))
    out = {}
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(stat)
        out[m.group(1)] = stat[m.end():end].strip().rstrip(';').strip()
    for alt in ('Prerequisite Charm', 'Prerequisites', 'Prerequisite'):
        if alt in out and 'Prerequisite Charms' not in out:
            out['Prerequisite Charms'] = out[alt]
        out.pop(alt, None)
    return out


SMALL = {'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of',
         'on', 'or', 'the', 'to', 'upon', 'with', 'without'}


SEPARATORS = re.compile(r'([-/(\[)\]—–:,.’\'"]|\s+)')


def titlecase(name):
    """The PDFs set charm names in capitals; the sheet shows them as titles.

    Words are capitalised across every separator, not just spaces, so
    "FIRST (ABILITY) EXCELLENCY—ESSENCE OVERWHELMING" keeps its parenthetical
    and the word after the dash. Short joining words stay lowercase unless they
    open or close the name or follow a punctuation break.
    """
    name = clean(name).rstrip('*').strip()
    parts = [p for p in SEPARATORS.split(name) if p != '']
    words = [i for i, p in enumerate(parts) if p.strip() and not SEPARATORS.fullmatch(p)]
    out = list(parts)
    for n, i in enumerate(words):
        low = parts[i].lower()
        if i and parts[i - 1] in ('’', "'"):
            out[i] = low                       # the possessive s, not a new word
            continue
        opens = n == 0 or n == len(words) - 1
        after_break = n > 0 and not parts[words[n - 1] + 1:i] == [' ']
        out[i] = low if (low in SMALL and not opens and not after_break) \
            else low[:1].upper() + low[1:]
    # Roman numerals and a few tokens that must stay shouted.
    return re.sub(r'\b(Ii|Iii|Iv|Dv|Mdv)\b', lambda m: m.group(1).upper(), ''.join(out))


def slug(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    s = re.sub(r"['’]", '', s).lower()
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s or 'charm'
