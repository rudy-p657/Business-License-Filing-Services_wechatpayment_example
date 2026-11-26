from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).parent
SCALE = 4
SIZE = 200 * SCALE

PALETTES = {
    "annual-1": {
        "bg": "#EFF6FA",
        "navy": "#183A5B",
        "blue": "#4C86AE",
        "green": "#35A77B",
        "line": "#D5E2EA",
    },
    "annual-2": {
        "bg": "#F2F5F8",
        "navy": "#243F5B",
        "blue": "#6689A6",
        "green": "#4D9C84",
        "line": "#D9E1E7",
    },
    "annual-cancel": {
        "bg": "#F6F5F1",
        "navy": "#203B58",
        "blue": "#6D8DA4",
        "green": "#4B9A79",
        "line": "#E0E1DD",
        "red": "#C95050",
    },
}


def px(value):
    return int(round(value * SCALE))


def rect(draw, box, fill, radius=0, outline=None, width=1):
    scaled = tuple(px(value) for value in box)
    if radius:
        draw.rounded_rectangle(
            scaled,
            radius=px(radius),
            fill=fill,
            outline=outline,
            width=px(width),
        )
    else:
        draw.rectangle(scaled, fill=fill, outline=outline, width=px(width))


def ellipse(draw, box, fill, outline=None, width=1):
    draw.ellipse(
        tuple(px(value) for value in box),
        fill=fill,
        outline=outline,
        width=px(width),
    )


def line(draw, points, fill, width):
    draw.line(
        [(px(x), px(y)) for x, y in points],
        fill=fill,
        width=px(width),
        joint="curve",
    )


def shadowed_card(image, box, radius, fill, outline=None):
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shifted = (box[0], box[1] + 4, box[2], box[3] + 4)
    rect(shadow_draw, shifted, (27, 54, 78, 38), radius)
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(px(4))))
    rect(ImageDraw.Draw(image), box, fill, radius, outline, 1)


def draw_report(image, palette, box=(49, 24, 151, 174)):
    x1, y1, x2, y2 = box
    shadowed_card(image, box, 9, "#FFFFFF", palette["line"])
    draw = ImageDraw.Draw(image)
    rect(draw, (x1 + 12, y1 + 13, x2 - 12, y1 + 20), palette["navy"], 3)
    rect(draw, (x1 + 12, y1 + 29, x2 - 12, y1 + 31), palette["line"], 1)
    rect(draw, (x1 + 12, y1 + 43, x2 - 24, y1 + 46), palette["blue"], 1)
    rect(draw, (x1 + 12, y1 + 54, x2 - 12, y1 + 57), palette["line"], 1)
    rect(draw, (x1 + 12, y1 + 67, x2 - 20, y1 + 70), palette["line"], 1)
    rect(draw, (x1 + 12, y1 + 80, x2 - 12, y1 + 83), palette["line"], 1)
    rect(draw, (x1 + 12, y1 + 96, x2 - 31, y1 + 99), palette["blue"], 1)
    rect(draw, (x1 + 12, y1 + 107, x2 - 12, y1 + 110), palette["line"], 1)


def check_badge(image, palette, center=(143, 143), radius=20):
    cx, cy = center
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ellipse(ImageDraw.Draw(shadow), (cx - radius, cy - radius + 2, cx + radius, cy + radius + 2), (22, 66, 60, 42))
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(px(3))))
    draw = ImageDraw.Draw(image)
    ellipse(draw, (cx - radius, cy - radius, cx + radius, cy + radius), palette["green"])
    line(draw, [(cx - 8, cy), (cx - 2, cy + 6), (cx + 9, cy - 7)], "#FFFFFF", 4)


def make_one_year(palette):
    image = Image.new("RGBA", (SIZE, SIZE), palette["bg"])
    draw_report(image, palette, (49, 24, 151, 174))
    draw = ImageDraw.Draw(image)
    rect(draw, (54, 50, 59, 149), palette["navy"], 2)
    check_badge(image, palette, (145, 145), 19)
    return image


def make_two_year(palette):
    image = Image.new("RGBA", (SIZE, SIZE), palette["bg"])
    shadowed_card(image, (40, 34, 134, 166), 9, "#E5EDF2", "#CFDBE3")
    back = ImageDraw.Draw(image)
    rect(back, (52, 48, 118, 54), palette["blue"], 3)
    for y in (69, 82, 95, 108, 121, 134):
        rect(back, (52, y, 119 - (y % 3) * 5, y + 2), "#CBD8E1", 1)
    draw_report(image, palette, (61, 22, 159, 169))
    draw = ImageDraw.Draw(image)
    rect(draw, (66, 48, 71, 145), palette["navy"], 2)
    check_badge(image, palette, (148, 143), 19)
    return image


def make_cancel(palette):
    image = Image.new("RGBA", (SIZE, SIZE), palette["bg"])
    draw_report(image, palette, (45, 23, 148, 174))
    draw = ImageDraw.Draw(image)
    rect(draw, (50, 49, 55, 150), palette["navy"], 2)
    cx, cy, radius = 147, 145, 20
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ellipse(ImageDraw.Draw(shadow), (cx - radius, cy - radius + 3, cx + radius, cy + radius + 3), (55, 31, 31, 40))
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(px(3))))
    draw = ImageDraw.Draw(image)
    ellipse(draw, (cx - radius, cy - radius, cx + radius, cy + radius), "#FFFFFF", palette["red"], 3)
    line(draw, [(cx - 8, cy - 8), (cx + 8, cy + 8)], palette["red"], 4)
    line(draw, [(cx + 8, cy - 8), (cx - 8, cy + 8)], palette["red"], 4)
    return image


RENDERERS = {
    "annual-1": make_one_year,
    "annual-2": make_two_year,
    "annual-cancel": make_cancel,
}


for name, render in RENDERERS.items():
    palette = PALETTES[name]
    image = render(palette).convert("RGB")
    image = image.resize((200, 200), Image.Resampling.LANCZOS)
    image.save(ROOT / f"{name}.png", format="PNG", optimize=True)
