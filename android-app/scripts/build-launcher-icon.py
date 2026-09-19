"""Build the Android launcher icon set (legacy PNGs + adaptive icon) from the
real Golden Break 8-ball mark (../../assets/logo-mark.png), replacing the
generic system placeholder icon the app shipped with.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "assets" / "logo-mark.png"
RES = ROOT / "app" / "src" / "main" / "res"

# (density folder, legacy launcher px, adaptive foreground canvas px)
# Adaptive foreground canvas is nominally 108dp with the safe zone being the
# center 72dp (~66.7%) — content outside that can be clipped by round/squircle
# masks depending on launcher, so the mark is scaled to fit inside it.
DENSITIES = [
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
]

WHITE = (255, 255, 255, 255)


def trimmed_mark() -> Image.Image:
    im = Image.open(SOURCE).convert("RGBA")
    return im.crop(im.getbbox())


def square_on_white(mark: Image.Image, canvas_size: int, content_fraction: float) -> Image.Image:
    canvas = Image.new("RGBA", (canvas_size, canvas_size), WHITE)
    target = int(canvas_size * content_fraction)
    scale = min(target / mark.width, target / mark.height)
    resized = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.Resampling.LANCZOS,
    )
    x = (canvas_size - resized.width) // 2
    y = (canvas_size - resized.height) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def square_transparent(mark: Image.Image, canvas_size: int, content_fraction: float) -> Image.Image:
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    target = int(canvas_size * content_fraction)
    scale = min(target / mark.width, target / mark.height)
    resized = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.Resampling.LANCZOS,
    )
    x = (canvas_size - resized.width) // 2
    y = (canvas_size - resized.height) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def main() -> None:
    mark = trimmed_mark()

    for folder, legacy_px, fg_px in DENSITIES:
        out_dir = RES / folder
        out_dir.mkdir(parents=True, exist_ok=True)

        # Legacy launcher icon (pre-adaptive-icon fallback / app store listings) —
        # mark fills most of the square, white background, no transparency.
        legacy = square_on_white(mark, legacy_px, content_fraction=0.72)
        legacy.save(out_dir / "ic_launcher.png")
        legacy.save(out_dir / "ic_launcher_round.png")

        # Adaptive icon foreground — mark inside the safe zone, transparent
        # elsewhere so the white background layer shows through and the OS's
        # own mask (circle/squircle/rounded-square) can clip it safely.
        foreground = square_transparent(mark, fg_px, content_fraction=0.45)
        foreground.save(out_dir / "ic_launcher_foreground.png")

    # Adaptive icon definition (API 26+, which is this app's entire install
    # base since minSdk=26) — solid white background + the foreground above.
    values_dir = RES / "values"
    values_dir.mkdir(parents=True, exist_ok=True)
    colors_path = values_dir / "colors.xml"
    colors_path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="ic_launcher_background">#FFFFFF</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )

    anydpi_dir = RES / "mipmap-anydpi-v26"
    anydpi_dir.mkdir(parents=True, exist_ok=True)
    adaptive_xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        "</adaptive-icon>\n"
    )
    (anydpi_dir / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (anydpi_dir / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")

    print(f"wrote launcher icons for {len(DENSITIES)} densities under {RES}")


if __name__ == "__main__":
    main()
