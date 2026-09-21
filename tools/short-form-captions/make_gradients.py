"""Generate the edge-darkening gradients used behind the end cards.

A straight alpha ramp leaves a visible band edge, so the falloff is curved.
"""

import sys
from pathlib import Path

from PIL import Image


def gradient(width, height, edge, reach, peak, path):
    """Black gradient: `peak` opacity at `edge`, nothing `reach` into the frame."""
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pixels = image.load()
    span = int(height * reach)

    for offset in range(span):
        alpha = int(round(255 * peak * (1 - offset / span) ** 1.6))
        row = offset if edge == "top" else height - 1 - offset
        for x in range(width):
            pixels[x, row] = (0, 0, 0, alpha)

    image.save(path)
    return path


def main():
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)

    for width, height in ((1080, 1920), (720, 1280)):
        gradient(width, height, "bottom", 0.40, 0.15,
                 out_dir / f"bottom-{width}x{height}.png")
        gradient(width, height, "top", 0.45, 0.25,
                 out_dir / f"top-{width}x{height}.png")

    for path in sorted(out_dir.iterdir()):
        print(path.name)


if __name__ == "__main__":
    main()
