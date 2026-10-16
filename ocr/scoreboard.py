"""Scoreboard OCR: read game time, kills, and gold off a broadcast frame.

The Worlds broadcast HUD shows a top-center bar with, per side, kills and
gold, plus the game clock. This module crops those regions out of a frame
and OCRs them. Crop coordinates are fractions of frame width/height so they
scale across resolutions; they are initial guesses -- run the worker with
--calibrate on a live frame and adjust crops.json if the HUD layout differs.

Broadcast convention: the BLUE side is on the LEFT of the scoreboard, red
on the right. The app maps left -> blue, right -> red on that basis.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from PIL import Image

# Default crops as (x0, y0, x1, y1) fractions of (width, height).
# Tuned for the standard LoL broadcast top bar at 720p/1080p. Each number
# gets its OWN crop: kills and gold are separate visual elements, and OCR
# fragments decimal numbers ("45.2k" -> "45." + ".2k") when both are in one
# box. Right side is mirrored: gold sits left of kills.
DEFAULT_CROPS: dict[str, tuple[float, float, float, float]] = {
    "timer": (0.455, 0.002, 0.545, 0.060),
    "left_kills": (0.285, 0.002, 0.345, 0.060),
    "left_gold": (0.350, 0.002, 0.435, 0.060),
    "right_gold": (0.565, 0.002, 0.650, 0.060),
    "right_kills": (0.655, 0.002, 0.715, 0.060),
}

_OCR_ENGINE = None


def load_crops(crops_path: str | None) -> dict[str, tuple[float, float, float, float]]:
    if crops_path and Path(crops_path).exists():
        raw = json.loads(Path(crops_path).read_text())
        return {k: tuple(v) for k, v in raw.items()}  # type: ignore[return-value]
    return dict(DEFAULT_CROPS)


def _engine():
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def crop_region(img: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    w, h = img.size
    x0, y0, x1, y1 = box
    crop = img.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
    # Upscale small text for the OCR engine; threshold to white-on-black.
    crop = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS)
    # Grayscale + upscale only: RapidOCR does its own binarization, and a
    # hard threshold here was fragmenting digits (e.g. "45.2k" -> "45." + ".2k").
    return crop.convert("L")


def ocr_image(img: Image.Image) -> str:
    """Return all OCR'd text in an image, joined with spaces."""
    import numpy as np

    engine = _engine()
    result, _ = engine(np.array(img))
    if not result:
        return ""
    return " ".join(text for _, text, _ in result)


def ocr_regions(
    image_path: str, crops: dict[str, tuple[float, float, float, float]]
) -> dict[str, str]:
    img = Image.open(image_path).convert("RGB")
    out: dict[str, str] = {}
    for name, box in crops.items():
        out[name] = ocr_image(crop_region(img, box))
    return out


_TIMER_RE = re.compile(r"(\d{1,2})\s*:\s*(\d{2})")
_GOLD_DEC_RE = re.compile(r"(\d{1,3}\.\d{1,2})\s*k", re.IGNORECASE)
_GOLD_INT_RE = re.compile(r"(\d{1,3})\s*k", re.IGNORECASE)


def _squash(text: str) -> str:
    """Remove whitespace and collapse runs of '.' (OCR fragment artifact)."""
    squashed = re.sub(r"\s+", "", text)
    return re.sub(r"\.{2,}", ".", squashed)


def parse_timer(text: str) -> float | None:
    """'24:36' -> 24.6 minutes. None when no clock found.

    OCR often splits the seconds ('24:3 2 6'); squashing gives '24:326',
    where the middle digit of a 3-digit seconds field is a split artifact.
    """
    squashed = _squash(text)
    m = re.search(r"(\d{1,2}):(\d{2,4})", squashed)
    if m:
        minutes, seconds = int(m.group(1)), m.group(2)
        if len(seconds) == 2:
            sec = int(seconds)
        else:
            # Split artifact: OCR inserted extra digits inside the seconds
            # field ('24:326' -> '36'); first + last digits are the real ones.
            sec = int(seconds[0] + seconds[-1])
        if minutes <= 90 and sec < 60:
            return minutes + sec / 60.0
    return None


def parse_kills(text: str) -> int | None:
    """One small integer. None when nothing plausible found."""
    digits = re.sub(r"\D", "", text)
    if not digits:
        return None
    kills = int(digits)
    return kills if 0 <= kills <= 80 else None


def parse_gold(text: str) -> float | None:
    """'45.2k' -> 45.2 (thousands). None when nothing plausible found.

    OCR sometimes hallucinates a digit+dot inside the decimal ('38.1k' ->
    '38.3.1k'): the '.' is misread as '3.'. A gold value has exactly one
    '.', so collapse any 'digit . digits .' run to 'digit .' first.
    """
    squashed = _squash(text)
    repaired = squashed
    while True:
        fixed = re.sub(r"(\d)\.\d+\.", r"\1.", repaired)
        if fixed == repaired:
            break
        repaired = fixed
    m = _GOLD_DEC_RE.search(repaired)
    if m:
        gold = float(m.group(1))
        return gold if 0 <= gold <= 200 else None
    m = _GOLD_INT_RE.search(repaired)
    if m:
        gold = float(m.group(1))
        return gold if 0 <= gold <= 200 else None
    return None


def parse_frame(image_path: str, crops: dict[str, tuple[float, float, float, float]]) -> dict:
    """OCR one frame -> snapshot dict. Missing fields stay None."""
    texts = ocr_regions(image_path, crops)
    return {
        "game_time_min": parse_timer(texts.get("timer", "")),
        "left": {
            "kills": parse_kills(texts.get("left_kills", "")),
            "gold_k": parse_gold(texts.get("left_gold", "")),
        },
        "right": {
            "kills": parse_kills(texts.get("right_kills", "")),
            "gold_k": parse_gold(texts.get("right_gold", "")),
        },
        "raw_text": texts,
    }
