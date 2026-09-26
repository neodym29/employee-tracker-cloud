"""Build the Neo Nexus geometric display face (pip install fonttools shapely).

The outlines are original vector paths drawn for this app from the supplied
alphabet reference. Keeping the source paths here makes the asset editable.
"""

from math import cos, pi, sin
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from shapely.geometry import LineString
from shapely.geometry.polygon import orient
from shapely.ops import unary_union


def line(*points):
    return list(points)


def cubic(a, b, c, d, count=18):
    return [(
        (1 - t) ** 3 * a[0] + 3 * (1 - t) ** 2 * t * b[0] + 3 * (1 - t) * t ** 2 * c[0] + t ** 3 * d[0],
        (1 - t) ** 3 * a[1] + 3 * (1 - t) ** 2 * t * b[1] + 3 * (1 - t) * t ** 2 * c[1] + t ** 3 * d[1],
    ) for t in (i / count for i in range(count + 1))]


def arc(cx, cy, rx, ry, start, end, count=36):
    return [(cx + rx * cos((start + (end - start) * i / count) * pi / 180),
             cy + ry * sin((start + (end - start) * i / count) * pi / 180))
            for i in range(count + 1)]


# Coordinates follow the reference's 0–100 top-to-bottom cap-height grid.
# Open corners and omitted crossbars are intentional, not missing contours.
GLYPHS = {
    'A': (96, [line((3, 100), (48, 0), (93, 100))]),
    'B': (87, [line((3, 0), (56, 0)), cubic((56, 0), (91, 0), (91, 49), (55, 49)),
               line((8, 50), (55, 50)), cubic((55, 50), (98, 49), (96, 100), (53, 100)), line((3, 100), (53, 100))]),
    'C': (92, [arc(49, 50, 46, 50, -61, -299)]),
    'D': (94, [line((3, 0), (36, 0)), arc(36, 50, 55, 50, -90, 90), line((3, 100), (36, 100))]),
    'E': (91, [line((3, 0), (88, 0)), line((3, 0), (3, 48), (77, 48)), line((3, 100), (88, 100))]),
    'F': (91, [line((3, 100), (3, 0), (88, 0)), line((3, 50), (73, 50))]),
    'G': (100, [arc(50, 50, 46, 50, -65, -296), line((54, 51), (97, 51), (97, 84))]),
    'H': (93, [line((3, 0), (3, 100)), line((90, 0), (90, 100)), line((3, 50), (90, 50))]),
    'I': (56, [line((3, 0), (3, 100), (53, 100))]),
    'J': (84, [line((77, 0), (77, 62)), arc(45, 61, 32, 39, 0, 168)]),
    'K': (91, [line((3, 0), (3, 100)), line((87, 0), (38, 49), (89, 100))]),
    'L': (83, [line((3, 0), (3, 100), (80, 100))]),
    'M': (107, [line((3, 100), (3, 0), (54, 49), (104, 0), (104, 100))]),
    'N': (94, [line((3, 100), (3, 0), (91, 100), (91, 0))]),
    'O': (100, [arc(50, 50, 47, 50, 0, 360, 72)]),
    'P': (92, [line((3, 100), (3, 0), (52, 0)), cubic((52, 0), (105, 0), (105, 56), (52, 56)), line((3, 56), (52, 56))]),
    'Q': (101, [arc(49, 49, 46, 49, 0, 360, 72), line((69, 71), (99, 100))]),
    'R': (94, [line((3, 100), (3, 0), (52, 0)), cubic((52, 0), (105, 0), (105, 55), (52, 55)),
               line((3, 55), (52, 55)), line((48, 55), (91, 100))]),
    'S': (94, [line((88, 0), (38, 0)), cubic((38, 0), (-8, 0), (-8, 43), (45, 50)),
               cubic((45, 50), (100, 56), (104, 100), (52, 100)), line((52, 100), (3, 100))]),
    'T': (94, [line((3, 0), (91, 0)), line((47, 0), (47, 100))]),
    'U': (94, [line((3, 0), (3, 63)), arc(47, 63, 44, 37, 180, 0), line((91, 63), (91, 0))]),
    'V': (98, [line((3, 0), (49, 100), (95, 0))]),
    'W': (110, [line((3, 0), (3, 100), (55, 53), (107, 100), (107, 0))]),
    'X': (98, [line((3, 0), (95, 100)), line((95, 0), (3, 100))]),
    'Y': (98, [line((3, 0), (49, 51), (95, 0)), line((49, 51), (49, 100))]),
    'Z': (94, [line((3, 0), (91, 0), (3, 100), (91, 100))]),
    '0': (92, [arc(46, 50, 43, 50, 0, 360, 72)]),
    '1': (58, [line((5, 23), (35, 0), (35, 100))]),
    '2': (88, [cubic((3, 27), (3, -13), (85, -13), (85, 25)), cubic((85, 25), (85, 49), (27, 76), (3, 100)), line((3, 100), (85, 100))]),
    '3': (86, [cubic((3, 4), (99, -13), (99, 45), (46, 50)), cubic((46, 50), (99, 53), (99, 112), (3, 96))]),
    '4': (93, [line((71, 100), (71, 0)), line((71, 0), (3, 68), (90, 68))]),
    '5': (88, [line((82, 0), (8, 0), (8, 47)), cubic((8, 47), (112, 22), (112, 114), (3, 100))]),
    '6': (90, [cubic((78, 0), (16, -1), (3, 41), (3, 70)), arc(45, 71, 42, 29, 180, -180, 56)]),
    '7': (89, [line((3, 0), (86, 0), (25, 100))]),
    '8': (90, [arc(45, 25, 39, 25, 0, 360, 48), arc(45, 73, 43, 27, 0, 360, 48)]),
    '9': (90, [arc(45, 29, 42, 29, 0, 360, 56), cubic((87, 29), (86, 64), (73, 91), (13, 100))]),
}


def contours_for(paths, thickness):
    ink = unary_union([LineString(path).buffer(thickness, cap_style=2, join_style=1, quad_segs=8)
                       for path in paths])
    pieces = [ink] if ink.geom_type == 'Polygon' else list(ink.geoms)
    for polygon in pieces:
        polygon = orient(polygon, sign=1)
        yield polygon.exterior.coords
        yield from (interior.coords for interior in polygon.interiors)


def glyph_for(paths, thickness):
    pen = TTGlyphPen(None)
    for contour in contours_for(paths, thickness):
        points = [(round((x + 5) * 7), round((100 - y) * 7)) for x, y in contour[:-1]]
        if len(points) < 3:
            continue
        pen.moveTo(points[0])
        for point in points[1:]:
            pen.lineTo(point)
        pen.closePath()
    return pen.glyph()


def build(family, filename, thickness):
    order = ['.notdef', 'space', *GLYPHS]
    glyphs = {'.notdef': TTGlyphPen(None).glyph(), 'space': TTGlyphPen(None).glyph()}
    metrics = {'.notdef': (700, 35), 'space': (315, 0)}
    mapping = {32: 'space'}
    for char, (width, paths) in GLYPHS.items():
        if family == 'Neo Nexus UI' and char == 'I':
            paths = [line((3, 0), (53, 0)), line((28, 0), (28, 100)), line((3, 100), (53, 100))]
        glyphs[char] = glyph_for(paths, thickness)
        metrics[char] = ((width + 10) * 7, 35)
        mapping[ord(char)] = char
        if char.isalpha():
            mapping[ord(char.lower())] = char
    font = FontBuilder(1000, isTTF=True)
    font.setupGlyphOrder(order)
    font.setupCharacterMap(mapping)
    font.setupGlyf(glyphs)
    font.setupHorizontalMetrics(metrics)
    font.setupHorizontalHeader(ascent=820, descent=-180)
    font.setupNameTable({
        'familyName': family,
        'styleName': 'Regular',
        'fullName': family,
        'psName': family.replace(' ', '') + '-Regular',
        'uniqueFontIdentifier': family + ' 1.0',
        'version': 'Version 1.0',
    })
    font.setupOS2(sTypoAscender=820, sTypoDescender=-180, usWinAscent=820,
                  usWinDescent=180, sCapHeight=700, sxHeight=700, usWeightClass=300)
    font.setupPost()
    font.setupMaxp()
    target = Path(__file__).resolve().parents[1] / 'public' / 'fonts' / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    font.save(target)
    print(f'Built {target} ({target.stat().st_size:,} bytes)')


if __name__ == '__main__':
    build('Neo Nexus Display', 'neo-nexus-display.ttf', 2.1)
    build('Neo Nexus UI', 'neo-nexus-ui.ttf', 4.6)
