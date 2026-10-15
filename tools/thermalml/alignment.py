"""
Has a camera moved since a period's reference day? Checked directly, with no people involved.

A period's mapping (photo -> thermal) is fitted once, on days known to be
in one place. A new day may use it only if both cameras are still where they
were, so before a day is labelled:

    photo camera    the median of up to 80 of its photos, aligned to the
                    reference day's by ECC on edges (rotation + shift)
    thermal sensor  its static background (the edge's method), aligned to the
                    reference day's by phase correlation

Within October (6-11 Oct) these measured 0.0-0.7 photo px and 0.04 thermal px
(docs/THERMAL_ML.md); the limits below sit well above that noise and well
under the 4.8 px the September and October mappings differ by.
"""
from __future__ import annotations

import os

import numpy as np

PHOTO_PX = 2.0           # of a 640x480 photo
PHOTO_DEG = 0.3
THERMAL_PX = 0.25        # of the 32x24 sensor


def median_photo(folder: str, n: int = 80) -> np.ndarray | None:
    import cv2
    files = sorted(f for f in os.listdir(folder) if f.endswith('.jpg')) if os.path.isdir(folder) else []
    files = files[::max(1, len(files) // n)][:n]
    imgs = [img.astype(np.float32) for img in (cv2.imread(os.path.join(folder, f), cv2.IMREAD_GRAYSCALE) for f in files)
            if img is not None]
    return np.median(np.stack(imgs), axis=0) if imgs else None


def photo_shift(ref: np.ndarray, img: np.ndarray) -> tuple[float, float, float] | None:
    """(dx px, dy px, rotation deg) taking img onto ref, or None if ECC finds no alignment."""
    import cv2
    edges = [cv2.GaussianBlur(cv2.Sobel(cv2.GaussianBlur(x, (5, 5), 0), cv2.CV_32F, 1, 1, ksize=3), (9, 9), 0) for x in (ref, img)]
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _score, warp = cv2.findTransformECC(edges[0], edges[1], warp, cv2.MOTION_EUCLIDEAN,
                                            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
    except cv2.error:
        return None
    return float(warp[0, 2]), float(warp[1, 2]), float(np.degrees(np.arctan2(warp[1, 0], warp[0, 0])))


def thermal_background(shards_root: str, uid: str, day: str) -> np.ndarray | None:
    from .shards import read_shard
    from .staticbg import DEFAULT, StaticBackground
    s = read_shard(shards_root, uid, day)
    bg, t = StaticBackground(DEFAULT), s.temps().reshape(len(s), -1)
    for i in range(len(s)):
        bg.add(t[i], float(s.at[i]))
    return None if bg.rel is None else bg.rel.reshape(24, 32).astype(np.float32)


def thermal_shift(ref: np.ndarray, bg: np.ndarray) -> tuple[float, float]:
    import cv2
    up = lambda x: cv2.resize(x, (320, 240), interpolation=cv2.INTER_CUBIC)
    (dx, dy), _resp = cv2.phaseCorrelate(up(ref), up(bg))
    return dx / 10, dy / 10


def same_place(ref_day: str, day: str, rgb_root: str, shards_root: str, uid: str) -> tuple[bool, str]:
    """Whether both cameras on `day` are where they were on `ref_day`, and the measurement that says so."""
    sdir = uid.replace(':', '')
    return same_place_as(median_photo(os.path.join(rgb_root, sdir, ref_day)), ref_day, day, rgb_root, shards_root, uid)


def same_place_as(ref_photo: np.ndarray | None, ref_day: str, day: str, rgb_root: str, shards_root: str,
                  uid: str) -> tuple[bool, str]:
    """same_place, against a reference median photo kept from before the reference day's photos were deleted."""
    a, b = ref_photo, median_photo(os.path.join(rgb_root, uid.replace(':', ''), day))
    if a is None or b is None:
        return False, 'no photos to compare'
    p = photo_shift(a, b)
    if p is None:
        return False, 'the photo camera could not be aligned to the reference day: cannot tell whether it moved'
    ta, tb = thermal_background(shards_root, uid, ref_day), thermal_background(shards_root, uid, day)
    if ta is None or tb is None:
        return False, 'no thermal background for one of the days: cannot tell whether the sensor moved'
    t = thermal_shift(ta, tb)
    said = f'photo camera {np.hypot(p[0], p[1]):.1f} px, {p[2]:+.2f} deg; thermal sensor {np.hypot(*t):.2f} px from {ref_day}'
    moved = np.hypot(p[0], p[1]) > PHOTO_PX or abs(p[2]) > PHOTO_DEG or np.hypot(*t) > THERMAL_PX
    return (not moved), ('moved: ' if moved else 'in place: ') + said
