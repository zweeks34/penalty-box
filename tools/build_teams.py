"""
Turn a folder of league logo files into Penalty Box's teams.json.

For each image:
  1. Trim the uniform border (transparent, or the corner color for JPGs).
  2. Fit into a 128x128 transparent square with a small margin -> WebP data URL.
  3. Suggest a team color: the dominant saturated hue in the logo; if the logo
     is mostly black/white/grey, black or silver. Snapped to the app's preset
     jersey colors when close, so the swatch shows as selected in Game setup.

Usage: python3 -I build_teams.py <logo_dir> <out_teams.json> <out_contact_sheet.png>
"""
import base64, colorsys, io, json, re, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

SIZE = 128
MARGIN = 0.04
PRESETS = {  # keep in sync with js/teams.js
    'Red': '#c8102e', 'Maroon': '#7a1e2e', 'Orange': '#f47a20', 'Gold': '#ffb81c',
    'Green': '#00703c', 'Teal': '#00778b', 'Light blue': '#4b9cd3', 'Royal': '#0047bb',
    'Navy': '#0b2346', 'Purple': '#5f259f', 'Black': '#111111', 'Silver': '#a2aaad',
}
# Display names where splitting the file name isn't enough.
NAME_FIXES = {
    'Carolina Jr Canes': 'Carolina Jr. Canes',
    'The St James': 'The St. James',
    'Loudon Knights': 'Loudoun Knights',     # spelled "LOUDOUN" on the logo itself
    'Tomorrows Ice': "Tomorrow's Ice",
}
# Colors chosen by eye where the automatic pick latched onto a minor element.
COLOR_OVERRIDES = {
    'Baltimore Stars': PRESETS['Green'],       # muted star green -> nearest jersey green
    'Capitals Academy': PRESETS['Red'],        # Caps red, not the navy outline
    'Chevy Chase': PRESETS['Red'],             # red/black shield, not the gold trim
    'Hampton Roads Whalers': PRESETS['Green'], # green ring is the dominant mark
    'Junior Black Bears': PRESETS['Black'],
    'Loudoun Knights': PRESETS['Black'],       # black and vegas gold
    'Navy Youth Hockey': PRESETS['Navy'],
    'Richmond Hockey Club': PRESETS['Teal'],   # teal wordmark, not the navy outline
    'Tri-City Eagles': PRESETS['Royal'],
}

def rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def to_hex(c): return '#%02x%02x%02x' % tuple(int(round(v)) for v in c)

def redmean(a, b):
    rm = (a[0] + b[0]) / 2
    return ((2 + rm / 256) * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + (2 + (255 - rm) / 256) * (a[2] - b[2]) ** 2) ** 0.5

def display_name(stem):
    # "Tri-CityEagles" -> "Tri-City Eagles", "CarolinaJrCanes" -> "Carolina Jr Canes"
    name = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', stem)
    return NAME_FIXES.get(name, name)

def trim(img):
    """Crop away the border. Returns (cropped RGBA, background RGB or None if transparent)."""
    alpha = img.getchannel('A')
    if alpha.getextrema()[0] < 250:                     # has real transparency
        box = alpha.point(lambda a: 255 if a > 16 else 0).getbbox()
        return (img.crop(box) if box else img), None
    w, h = img.size
    corners = [img.getpixel(p)[:3] for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))   # robust-ish corner color
    diff = ImageChops.difference(img.convert('RGB'), Image.new('RGB', img.size, bg)).convert('L')
    box = diff.point(lambda d: 255 if d > 24 else 0).getbbox()
    return (img.crop(box) if box else img), bg

def fit(img):
    inner = int(SIZE * (1 - 2 * MARGIN))
    img = img.copy()
    img.thumbnail((inner, inner), Image.LANCZOS)
    out = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2), img)
    return out

def suggest_color(img, bg):
    """Dominant team color from the logo's pixels (ignoring background)."""
    small = img.copy()
    small.thumbnail((96, 96))
    hue_bins = {}     # 12 hue buckets of chromatic pixels
    dark = light = total = 0
    for r, g, b, a in small.get_flattened_data():
        if a < 128: continue
        if bg and redmean((r, g, b), bg) < 40: continue
        total += 1
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.35 and v > 0.18:
            hue_bins.setdefault(int(h * 12) % 12, []).append((r, g, b))
        elif v < 0.3: dark += 1
        else: light += 1
    if not total:
        return PRESETS['Black'], 'empty'
    best = max(hue_bins.values(), key=len, default=[])
    if len(best) >= 0.08 * total:
        # Median per channel: resists anti-aliasing and highlights.
        c = tuple(sorted(p[i] for p in best)[len(best) // 2] for i in range(3))
        how = 'logo'
    else:
        c = rgb(PRESETS['Black'] if dark >= light * 0.5 else PRESETS['Silver'])
        how = 'neutral'
    name, ph = min(PRESETS.items(), key=lambda kv: redmean(c, rgb(kv[1])))
    if redmean(c, rgb(ph)) < 90:
        return ph, f'{how}->{name}'
    return to_hex(c), how

def main(src_dir, out_json, sheet_path):
    teams, tiles = [], []
    for f in sorted(Path(src_dir).iterdir(), key=lambda p: p.name.lower()):
        if f.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'): continue
        try:
            img = Image.open(f).convert('RGBA')
        except Exception as e:
            print(f'SKIP {f.name}: {e}'); continue
        cropped, bg = trim(img)
        logo = fit(cropped)
        color, how = suggest_color(cropped, bg)
        buf = io.BytesIO(); logo.save(buf, 'WEBP', quality=85, method=6)
        data = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()
        name = display_name(f.stem)
        assert len(name) <= 24, name
        if name in COLOR_OVERRIDES:
            color, how = COLOR_OVERRIDES[name], 'override'
        teams.append({'name': name, 'color': color, 'logo': data})
        tiles.append((name, color, logo, how, img.size, len(buf.getvalue())))
        print(f'{name:26} {color} {how:16} src {img.size[0]}x{img.size[1]:<5} -> {len(buf.getvalue()):>5} B')

    Path(out_json).write_text(json.dumps({'version': 1, 'teams': teams}, indent=2) + '\n')

    # Contact sheet for review: logo on white chip + color bar + name.
    cols, tw, th = 5, 200, 190
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * tw, rows * th), '#141c29')
    d = ImageDraw.Draw(sheet)
    for i, (name, color, logo, how, _, _) in enumerate(tiles):
        x, y = (i % cols) * tw, (i // cols) * th
        d.rectangle([x + 10, y + 10, x + tw - 10, y + 40], fill=color)
        d.rounded_rectangle([x + 36, y + 46, x + 164, y + 174], 10, fill='white')
        sheet.paste(logo, (x + 36, y + 46), logo)
        d.text((x + 14, y + 16), name[:26], fill='white' if sum(rgb(color)) < 450 else 'black')
    sheet.save(sheet_path)

if __name__ == '__main__':
    main(*sys.argv[1:4])
