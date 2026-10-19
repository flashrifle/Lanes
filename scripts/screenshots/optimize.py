#!/usr/bin/env python3
"""Shrink screenshot PNGs in place: pngquant when installed, else a 256-colour Pillow palette (no dithering)."""
import shutil
import subprocess
import sys

from PIL import Image

for path in sys.argv[1:]:
    if shutil.which('pngquant'):
        subprocess.run(['pngquant', '--force', '--skip-if-larger', '--quality=70-95', '--output', path, path], check=False)
        continue
    im = Image.open(path).convert('RGB')
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
