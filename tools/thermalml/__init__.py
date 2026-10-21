"""
Offline data tools for the thermal people detector.

The edge counts people from 32x24 thermal frames; this package turns what the
training database recorded into something a model can be trained and judged
on, without ever letting the hand-labelled test days leak into training.

    copydump   rows of a plain-SQL pg_dump, streamed out of the export ZIP
    days       which day a frame belongs to, and which days are locked
    shards     one compact file per sensor per day: raw thermal + an index
    staticbg   the edge's day-long background, ported exactly from TypeScript

Run from the repository root:  python3 -m tools.thermalml --help
"""
