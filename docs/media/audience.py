"""Pixel-art crowd for the README: a generated audience, every person different, on phone or laptop."""
# Regenerate: python3 docs/media/audience.py > docs/media/audience.svg
import random, sys

rng = random.Random(20261104)
SKIN = ["#f5d0b5", "#e8b896", "#c68e6a", "#a26a48", "#7a4a30", "#5a3522"]
HAIR = ["#1f1a17", "#4a3020", "#8a5a2b", "#d8b26a", "#b04a2a", "#9a9a9a", "#e6e6e6", "#3a2a5a"]
SHIRT = ["#4f7cff", "#ff6b6b", "#2ec4b6", "#ffbe0b", "#8338ec", "#3a86ff", "#fb5607", "#06d6a0", "#ef476f", "#118ab2", "#adb5bd", "#2b2d42"]
P = 4  # one art pixel, in SVG units
COLS, ROWS, W, H = 12, 4, 12, 18  # people per row, rows, cell size in art pixels

def person(ox, oy):
    px = []
    put = lambda x, y, c: px.append((ox + x, oy + y, c))
    skin, hair, shirt = rng.choice(SKIN), rng.choice(HAIR), rng.choice(SHIRT)
    style, device = rng.randrange(4), rng.random() < 0.55  # True: phone, False: laptop
    for y in range(3, 8):          # head
        for x in range(4, 8):
            put(x, y, skin)
    put(5, 5, "#1b1b1b"); put(7, 5, "#1b1b1b")  # eyes
    if rng.random() < 0.25:        # glasses
        for x in (4, 5, 6, 7): put(x, 5, "#1b1b1b")
    for x in range(3, 9):          # hair
        put(x, 2, hair)
    put(3, 3, hair); put(8, 3, hair)
    if style == 1:                 # long hair
        for y in range(4, 9): put(3, y, hair); put(8, y, hair)
    elif style == 2:               # bun
        put(5, 1, hair); put(6, 1, hair)
    elif style == 3:               # cap
        for x in range(3, 10): put(x, 2, shirt)
    for y in range(8, 14):         # body
        for x in range(3, 9):
            put(x, y, shirt)
    for y in range(14, 17):        # legs
        put(4, y, "#2b2d42"); put(7, y, "#2b2d42")
    if device:                     # phone in hand
        for y in range(9, 13): put(9, y, "#111"); put(10, y, "#111")
        put(9, 10, "#7fd1ff"); put(10, 10, "#7fd1ff"); put(9, 11, "#7fd1ff"); put(10, 11, "#7fd1ff")
        put(8, 11, skin)
    else:                          # laptop on lap
        for x in range(2, 10): put(x, 13, "#c9ced6")
        for x in range(3, 9):
            for y in range(10, 13): put(x, y, "#3b3f46")
        for x in range(4, 8): put(x, 11, "#7fd1ff")
    return px

rects = []
for r in range(ROWS):
    for c in range(COLS):
        for x, y, col in person(c * W + (r % 2) * 6, r * H):
            rects.append(f'<rect x="{x*P}" y="{y*P}" width="{P}" height="{P}" fill="{col}"/>')
w, h = (COLS * W + 6) * P, ROWS * H * P
sys.stdout.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" shape-rendering="crispEdges" role="img" aria-label="A generated audience: 48 different people, on phones and laptops">'
                 f'<rect width="{w}" height="{h}" fill="#0d1117"/>' + "".join(rects) + "</svg>\n")
