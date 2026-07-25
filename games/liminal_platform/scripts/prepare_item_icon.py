#!/usr/bin/env python3
"""Prepare inventory / hold icons: strip near-black mattes, crop, scale to RGBA PNG.

Usage:
  python3 prepare_item_icon.py INPUT.png -o static/img/items/foo-icon.png
  python3 prepare_item_icon.py INPUT.jpg -o out.png --max-side 256 --pad 8

Convention for liminal item icons:
  - Real PNG with alpha (not JPEG renamed to .png)
  - Content fills most of the frame (tight crop + small pad)
  - Catalog `icon` / `holdSprite` URLs use `?v=N` and bump when the file changes
  - UI slots use CSS: transparent bg, contain, center (see .lp-item-icon-image)
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image
import numpy as np


def prepare_icon(
    src: Path,
    *,
    max_side: int = 256,
    pad: int = 8,
    black_full: float = 18.0,
    black_edge: float = 28.0,
) -> Image.Image:
    """Strip near-black matte, crop to content, scale longest side to max_side."""
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    r = arr[:, :, 0].astype(np.float32)
    g = arr[:, :, 1].astype(np.float32)
    b = arr[:, :, 2].astype(np.float32)
    luma = (r + g + b) / 3.0
    alpha = arr[:, :, 3].astype(np.float32)
    alpha[luma < black_full] = 0.0
    edge = (luma >= black_full) & (luma < black_edge)
    alpha[edge] = ((luma[edge] - black_full) / (black_edge - black_full)) * 255.0
    arr[:, :, 3] = np.clip(alpha, 0, 255).astype(np.uint8)

    ys, xs = np.where(arr[:, :, 3] > 20)
    if xs.size == 0:
        raise SystemExit(f"No visible content after matte strip: {src}")

    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(arr.shape[1], int(xs.max()) + 1 + pad)
    y1 = min(arr.shape[0], int(ys.max()) + 1 + pad)
    cropped = Image.fromarray(arr[y0:y1, x0:x1], "RGBA")

    cw, ch = cropped.size
    scale = max_side / max(cw, ch)
    nw = max(1, int(round(cw * scale)))
    nh = max(1, int(round(ch * scale)))
    return cropped.resize((nw, nh), Image.Resampling.LANCZOS)


def main() -> None:
    """CLI entry: write a standardized inventory icon PNG."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Source image (PNG/JPEG/…)")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output RGBA PNG path")
    parser.add_argument("--max-side", type=int, default=256, help="Longest side after scale")
    parser.add_argument("--pad", type=int, default=8, help="Padding around content bbox (px)")
    parser.add_argument(
        "--black-full",
        type=float,
        default=18.0,
        help="Luma below this becomes fully transparent",
    )
    parser.add_argument(
        "--black-edge",
        type=float,
        default=28.0,
        help="Luma ramp end for soft matte edges",
    )
    args = parser.parse_args()

    out = prepare_icon(
        args.input,
        max_side=args.max_side,
        pad=args.pad,
        black_full=args.black_full,
        black_edge=args.black_edge,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.output, "PNG")
    print(f"wrote {args.output} size={out.size} mode={out.mode}")


if __name__ == "__main__":
    main()
