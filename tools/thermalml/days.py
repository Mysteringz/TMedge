"""
Which day a frame belongs to, and which days may never be trained on.

Days start at 04:00 Hong Kong time, not midnight: sessions run past midnight
and the rooms are empty around four, so a day boundary rarely cuts through a
person sitting at a desk.

The two hand-labelled days are the only test the team has. A model that saw
any frame from them -- for training, for fitting a background, as a pasted
example -- would score itself on frames it had seen, so every training path
goes through `assert_trainable`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

HKT = timezone(timedelta(hours=8))
DAY_START_HOUR = 4
DAY_MS = 24 * 3600_000
# Frames this close to a day boundary are left out of training and scoring,
# so two neighbouring days never share a moment.
BOUNDARY_MARGIN_MS = 30 * 60_000

# The 400 hand-labelled frames: 280 from 26 Sept and 120 from 29 Sept (team
# decision 2026-10-12). Locked for good; never extend this by accident.
LOCKED_DAYS = frozenset({'2026-09-26', '2026-09-29'})


class LockedDayError(RuntimeError):
    pass


def day_of(at_ms: int | float) -> str:
    local = datetime.fromtimestamp(at_ms / 1000, HKT) - timedelta(hours=DAY_START_HOUR)
    return local.strftime('%Y-%m-%d')


def day_start_ms(day: str) -> int:
    d = datetime.strptime(day, '%Y-%m-%d').replace(hour=DAY_START_HOUR, tzinfo=HKT)
    return int(d.timestamp() * 1000)


def is_locked(day: str) -> bool:
    return day in LOCKED_DAYS


def near_boundary(at_ms: int | float, margin_ms: int = BOUNDARY_MARGIN_MS) -> bool:
    start = day_start_ms(day_of(at_ms))
    return at_ms - start < margin_ms or start + DAY_MS - at_ms <= margin_ms


def assert_trainable(days: list[str] | set[str]) -> None:
    bad = sorted(set(days) & LOCKED_DAYS)
    if bad:
        raise LockedDayError(f'locked test days in a training set: {", ".join(bad)}')
