#!/usr/bin/env python3
"""Process the wrench-mascot v2 into favicon + brand assets.

- Removes white background (alpha = 0 where R,G,B all > 245)
- Crops to content with small margin
- Exports:
    public/favicon.png            (32x32, transparent)
    public/apple-touch-icon.png   (180x180, transparent)
    public/android-chrome-192.png (192x192, transparent)
    public/android-chrome-512.png (512x512, transparent)
    public/brand-mark.png         (512x512, transparent)
    public/favicon.ico            (multi-size 16/32/48, transparent)
"""
from PIL import Image
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "public", "favicon-variants", "wrench-mascot-clean3d-v2.png")
OUT  = os.path.join(ROOT, "public")

def remove_white_bg(im: Image.Image, threshold: int = 245) -> Image.Image:
    """Convert near-white pixels to fully transparent."""
    im = im.convert("RGBA")
    pixels = im.load()
    w, h = im.size
    # Sample only a few times for speed on large images
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                pixels[x, y] = (r, g, b, 0)
    return im

def crop_to_content(im: Image.Image, margin_pct: float = 0.04) -> Image.Image:
    """Crop transparent image to its non-transparent bounding box with margin."""
    bbox = im.getbbox()
    if not bbox:
        return im
    left, upper, right, lower = bbox
    w, h = im.size
    mx = int(w * margin_pct)
    my = int(h * margin_pct)
    left   = max(0, left - mx)
    upper  = max(0, upper - my)
    right  = min(w, right + mx)
    lower  = min(h, lower + my)
    return im.crop((left, upper, right, lower))

def main() -> int:
    if not os.path.exists(SRC):
        print(f"ERROR: source not found: {SRC}", file=sys.stderr)
        return 1

    print(f"Loading: {SRC}")
    raw = Image.open(SRC)
    print(f"  size: {raw.size}, mode: {raw.mode}")

    # 1. Strip white background, then crop to content
    cleaned = remove_white_bg(raw)
    cleaned = crop_to_content(cleaned)
    print(f"  cleaned+cropped: {cleaned.size}")

    # 2. Make a square canvas (center the content)
    w, h = cleaned.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(cleaned, ((side - w) // 2, (side - h) // 2), cleaned)
    print(f"  square canvas: {canvas.size}")

    # 3. Export at the sizes we need
    sizes = {
        "favicon.png":            32,
        "apple-touch-icon.png":  180,
        "android-chrome-192.png":192,
        "android-chrome-512.png":512,
        "brand-mark.png":        512,
    }
    for name, size in sizes.items():
        path = os.path.join(OUT, name)
        canvas.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
        sz = os.path.getsize(path)
        print(f"  wrote {name} ({size}x{size}, {sz} bytes)")

    # 4. Build multi-size .ico from 16/32/48 renders
    ico_sizes = [16, 32, 48]
    ico_images = [canvas.resize((s, s), Image.LANCZOS) for s in ico_sizes]
    ico_path = os.path.join(OUT, "favicon.ico")
    ico_images[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[1:],
    )
    print(f"  wrote favicon.ico (sizes {ico_sizes}, {os.path.getsize(ico_path)} bytes)")

    return 0

if __name__ == "__main__":
    sys.exit(main())
