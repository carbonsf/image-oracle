#!/usr/bin/env python3
"""Generate the PWA / favicon icon set from the card back.

The back (RoseLilyRed.jpg — the same one the tarot app uses) is framed as a
rounded card, centered on black with a soft deep-red glow, and exported at
every size the manifest / apple / favicon links reference. Same recipe as
the tarot app's _gen_icons.py, minus the ivory frame: this back already
carries its own red edge.

    python3 _gen_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "RoseLilyRed.jpg")

BLACK = (0, 0, 0)
GLOW = (150, 22, 10)           # deep red, very subtle

SS = 4                         # supersample factor for crisp downscale


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1],
                                        radius=radius, fill=255)
    return m


def build_card(card_h):
    """The back, resized to card_h, with rounded corners. Returns RGBA."""
    back = Image.open(SRC).convert("RGB")
    card_w = int(round(card_h * back.width / back.height))
    card = back.resize((card_w, card_h), Image.LANCZOS).convert("RGBA")
    card.putalpha(rounded_mask((card_w, card_h), int(card_w * 0.06)))
    return card


def compose(px, card_frac, glow=True):
    """Render one square icon at `px` pixels. card_frac = card height / canvas."""
    C = px * SS
    canvas = Image.new("RGBA", (C, C), BLACK + (255,))
    card = build_card(int(C * card_frac))

    if glow:
        g = Image.new("RGBA", (C, C), (0, 0, 0, 0))
        gx = (C - card.width) // 2
        gy = (C - card.height) // 2
        halo = Image.new("RGBA", card.size, (0, 0, 0, 0))
        ImageDraw.Draw(halo).rounded_rectangle(
            [0, 0, card.width - 1, card.height - 1],
            radius=int(card.width * 0.06), fill=GLOW + (170,))
        g.paste(halo, (gx, gy), halo)
        g = g.filter(ImageFilter.GaussianBlur(C * 0.045))
        canvas = Image.alpha_composite(canvas, g)

    x = (C - card.width) // 2
    y = (C - card.height) // 2
    canvas.alpha_composite(card, (x, y))
    return canvas.resize((px, px), Image.LANCZOS).convert("RGB")


def save(img, name):
    img.save(os.path.join(HERE, name))
    print("wrote", name, img.size)


# Standard icons: card fills ~80% of the height, with glow.
for px, name in [(180, "apple-touch-icon.png"),
                 (192, "icon-192.png"),
                 (512, "icon-512.png")]:
    save(compose(px, 0.80), name)

# Maskable: extra padding so the card stays inside the Android safe zone.
save(compose(512, 0.62), "icon-512-maskable.png")

# Favicons (browser tab / bookmarks).
master = compose(512, 0.84, glow=False)
for px in (16, 32, 48):
    save(master.resize((px, px), Image.LANCZOS), "favicon-%d.png" % px)
ico = master.resize((48, 48), Image.LANCZOS)
ico.save(os.path.join(HERE, "favicon.ico"),
         sizes=[(16, 16), (32, 32), (48, 48)])
print("wrote favicon.ico")
