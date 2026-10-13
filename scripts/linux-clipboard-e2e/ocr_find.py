#!/usr/bin/env python3
"""Find a visible word in a LatticeTerm screenshot using Tesseract TSV."""

from __future__ import annotations

import argparse
import csv
import io
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass(frozen=True)
class Word:
    text: str
    confidence: float
    left: int
    top: int
    width: int
    height: int

    @property
    def center_x(self) -> int:
        return self.left + self.width // 2

    @property
    def center_y(self) -> int:
        return self.top + self.height // 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("needle")
    parser.add_argument("--min-x", type=int, default=0)
    parser.add_argument("--min-y", type=int, default=0)
    parser.add_argument("--max-x", type=int, default=1_000_000)
    parser.add_argument("--max-y", type=int, default=1_000_000)
    parser.add_argument("--min-confidence", type=float, default=20.0)
    parser.add_argument("--scale", type=int, choices=(1, 2, 3), default=1)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    with tempfile.TemporaryDirectory(prefix="latticeterm-ocr-") as directory:
        image_path = args.image
        if args.scale != 1:
            image_path = Path(directory) / "scaled.png"
            with Image.open(args.image) as image:
                image.resize(
                    (image.width * args.scale, image.height * args.scale),
                    Image.Resampling.LANCZOS,
                ).save(image_path)
        completed = subprocess.run(
            [
                "tesseract",
                str(image_path),
                "stdout",
                "-l",
                "eng+chi_tra",
                "--psm",
                "11",
                "tsv",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    needle = args.needle.casefold()
    words: list[Word] = []
    for row in csv.DictReader(io.StringIO(completed.stdout), delimiter="\t"):
        text = (row.get("text") or "").strip()
        if not text or needle not in text.casefold():
            continue
        try:
            word = Word(
                text=text,
                confidence=float(row["conf"]),
                left=int(row["left"]) // args.scale,
                top=int(row["top"]) // args.scale,
                width=int(row["width"]) // args.scale,
                height=int(row["height"]) // args.scale,
            )
        except (KeyError, TypeError, ValueError):
            continue
        if word.confidence < args.min_confidence:
            continue
        if not (args.min_x <= word.center_x <= args.max_x):
            continue
        if not (args.min_y <= word.center_y <= args.max_y):
            continue
        words.append(word)

    if not words:
        return 1
    # Prefer the strongest recognition, then the top-most visible match.
    found = min(words, key=lambda word: (-word.confidence, word.top, word.left))
    print(
        found.center_x,
        found.center_y,
        found.left,
        found.top,
        found.width,
        found.height,
        found.text,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"OCR command failed: {error}", file=sys.stderr)
        raise SystemExit(2)
