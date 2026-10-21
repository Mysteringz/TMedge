"""
The nightly loop: each night, learn from the days so far and keep the better detector.

    python3 -m tools.thermalml.nightly --day 2026-10-11 [--set-champion model.json]
    hpc_job.py --stage nightly          (on the training machine: fetches and labels new days first)

For day d (the last finished day by default; days run 04:00-04:00 HKT):

  plan      d is the test day: no model trains on it or picks anything with it.
            The latest earlier day with enough people checks (epoch, threshold,
            the best of three runs); every other earlier day trains. Locked
            days never take part.
  train     a challenger from scratch, three runs, with the configured recipe.
  test      on d: the challenger, the champion (registry), and today's edge
            detector when a replay of it for d exists.
  gates     G1 data: no locked day in play, every day labelled.
            G2 better on d than what is live: the paired 95% interval of the F1
               difference above 0, no more false people on empty frames (+0.02)
               and no worse on frames with 2+ people (-0.03), and enough frames
               with people on d to tell (2,000).
            G3 the edge computes what Python computes, and G4 a 24-hour shadow
               day on the edge: not built yet. The edge has no ML detector mode,
               so a challenger that passes G1 and G2 is recorded as the shadow
               candidate and goes no further.
  report    nights/<d>/report.json and report.md: measured numbers only,
            "not measured" otherwise, and the series of earlier nights.
  registry  models/<id>.json (never changed once written) and active.json
            {champion, shadow, previous, history}.

The first champion is set by hand at a milestone (--set-champion), after the
hand test; until then the challenger is compared with the edge detector when
its replay is there, and otherwise nothing can be promoted.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import shutil
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

from . import days

HKT = timezone(timedelta(hours=8))
UID = '2c:cf:67:0b:c0:94'
MIN_PEOPLE_FRAMES = 2000      # G2 waits for at least this many frames with people on the test day
MIN_CHECK_PEOPLE = 300        # a day needs this many to be the check day
EMPTY_SLACK = 0.02            # false people per empty frame may rise by at most this much
BUSY_SLACK = 0.03             # F1 on frames with 2+ people may fall by at most this much
NOT_BUILT = ['G3: the edge computing exactly what Python computes, checked when the edge takes the model',
             'G4: a 24-hour shadow day on the edge, then switching automatically',
             'the 48-hour watchdog that rolls back a model that breaks the shadow limits',
             'a daily export the training machine can fetch without anyone clicking Prepare']


def yesterday(now: datetime | None = None) -> str:
    """The last finished day: a day runs 04:00-04:00 Hong Kong time."""
    now = (now or datetime.now(HKT)).astimezone(HKT)
    return (now - timedelta(hours=4) - timedelta(days=1)).date().isoformat()


def plan(people_frames: dict[str, int], day: str) -> dict:
    """{test, check, train, why}: which days do what tonight, by date alone."""
    out = {'test': day, 'check': None, 'train': [], 'why': None}
    if days.is_locked(day):
        out['why'] = f'{day} is a locked test day'
        return out
    if day not in people_frames:
        out['why'] = f'{day} has no labelled frames: nothing to test on'
        return out
    before = sorted(x for x in people_frames if x < day and not days.is_locked(x))
    checks = [x for x in before if people_frames[x] >= MIN_CHECK_PEOPLE]
    if not checks or len(before) < 2:
        out['why'] = 'fewer than two labelled days before it, one of them with enough people to check on'
        return out
    out['check'] = checks[-1]
    out['train'] = [x for x in before if x != out['check']]
    return out


@dataclass
class Gate:
    name: str
    passed: bool | None          # None: could not be decided tonight
    said: str


def slices(frames: list) -> dict:
    """False people per empty frame, and F1 on frames with 2+ people."""
    from .metrics import score_frames
    empty = [f for f in frames if f.truth == 0]
    busy = [f for f in frames if f.truth >= 2]
    return {'emptyFrames': len(empty), 'falsePerEmptyFrame': (sum(f.fp for f in empty) / len(empty)) if empty else None,
            'busyFrames': len(busy), 'busyF1': score_frames(busy)['f1'] if busy else None,
            'peopleFrames': sum(1 for f in frames if f.truth > 0)}


def g1(p: dict, labelled: set[str]) -> Gate:
    in_play = p['train'] + [p['check'], p['test']]
    locked = [x for x in in_play if days.is_locked(x)]
    missing = [x for x in in_play if x not in labelled]
    if locked or missing:
        return Gate('G1 data', False, f'locked days {locked}, unlabelled days {missing}')
    return Gate('G1 data', True, f'trained on {", ".join(p["train"])}; checked on {p["check"]}; tested on {p["test"]}')


def g2(challenger: dict, live: dict | None, live_name: str | None, diff: dict | None) -> Gate:
    """challenger and live: {'slices': slices(), ...}; diff: paired_bootstrap(live frames, challenger frames)."""
    n = challenger['slices']['peopleFrames']
    if n < MIN_PEOPLE_FRAMES:
        return Gate('G2 better on the test day', None, f'{n} frames with people; telling two models apart needs {MIN_PEOPLE_FRAMES}')
    if live is None or diff is None:
        return Gate('G2 better on the test day', None, 'nothing live to compare with: no champion yet and no replay of the edge detector')
    lo, hi = diff['f1ci95']
    if lo is None or hi is None or math.isnan(lo):
        return Gate('G2 better on the test day', None, 'the difference could not be measured')
    c, l = challenger['slices'], live['slices']
    worse_empty = (c['falsePerEmptyFrame'] is not None and l['falsePerEmptyFrame'] is not None
                   and c['falsePerEmptyFrame'] - l['falsePerEmptyFrame'] > EMPTY_SLACK)
    worse_busy = c['busyF1'] is not None and l['busyF1'] is not None and l['busyF1'] - c['busyF1'] > BUSY_SLACK
    said = f'F1 {diff["f1"]:+.3f} [{lo:+.3f}, {hi:+.3f}] against {live_name}'
    if worse_empty:
        said += f'; more false people on empty frames ({c["falsePerEmptyFrame"]:.3f} against {l["falsePerEmptyFrame"]:.3f})'
    if worse_busy:
        said += f'; worse on frames with 2+ people ({c["busyF1"]:.3f} against {l["busyF1"]:.3f})'
    return Gate('G2 better on the test day', lo > 0 and not worse_empty and not worse_busy, said)


def decide(gates: list[Gate]) -> str:
    failed = [g for g in gates if g.passed is False]
    open_ = [g for g in gates if g.passed is None]
    if failed:
        return 'kept what is live: ' + '; '.join(f'{g.name} failed ({g.said})' for g in failed)
    if open_:
        return 'kept what is live: ' + '; '.join(f'{g.name} not decided ({g.said})' for g in open_)
    return 'shadow candidate: passed every gate built so far; the shadow day on the edge is not built yet'


def saw(model: dict, day: str) -> bool:
    """Whether a model trained on, or chose its epoch and threshold with, this day."""
    return day in set(model.get('trainDays', [])) | set(model.get('valDays', []))


class Registry:
    """models/<id>.json, never rewritten; active.json says which is champion, shadow and previous."""

    def __init__(self, root: str) -> None:
        self.root = root
        os.makedirs(os.path.join(root, 'models'), exist_ok=True)

    def path(self, model_id: str) -> str:
        return os.path.join(self.root, 'models', f'{model_id}.json')

    def add(self, model_json: str) -> str:
        model_id = json.load(open(model_json))['id']
        if not os.path.exists(self.path(model_id)):
            shutil.copy(model_json, self.path(model_id) + '.tmp')
            os.replace(self.path(model_id) + '.tmp', self.path(model_id))
        return model_id

    def active(self) -> dict:
        f = os.path.join(self.root, 'active.json')
        return json.load(open(f)) if os.path.exists(f) else {'champion': None, 'shadow': None, 'previous': None, 'history': []}

    def set(self, why: str, **change: str | None) -> dict:
        a = self.active()
        if 'champion' in change and change['champion'] != a['champion']:
            a['previous'] = a['champion']
        a.update(change)
        a['history'] = a.get('history', []) + [{'at': datetime.now(HKT).isoformat(timespec='seconds'), 'why': why, **change}]
        f = os.path.join(self.root, 'active.json')
        with open(f + '.tmp', 'w') as out:
            json.dump(a, out, indent=1)
        os.replace(f + '.tmp', f)
        return a


def people_by_day(labels_root: str, features_root: str, shards_root: str, uid: str = UID) -> dict[str, int]:
    """Per labelled day, the frames a model can use (background ready, away from the day's ends) with a sure person."""
    import numpy as np
    from .shards import read_shard, sensor_dir
    folder = os.path.join(labels_root, sensor_dir(uid))
    out = {}
    for f in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if not f.endswith('.json'):
            continue
        day = f[:-5]
        npz = os.path.join(features_root, sensor_dir(uid), f'{day}.npz')
        if not os.path.exists(npz):
            out[day] = 0                  # no inputs computed for it yet: nothing usable
            continue
        frames = json.load(open(os.path.join(folder, f)))['frames']
        with np.load(npz) as z:
            ready, at = z['ready'], z['at']
        ids = read_shard(shards_root, uid, day).ids
        out[day] = sum(1 for i, tid in enumerate(ids) if ready[i] and tid in frames and frames[tid]['pts']
                       and not days.near_boundary(int(at[i])))
    return out


def run(day: str, data: dict, out_root: str, registry: Registry, recipe: dict, device: str = 'cpu',
        seeds: tuple[int, ...] = (0, 1, 2), quick: bool = False, uid: str = UID) -> dict:
    """One night. data: {'shards', 'features', 'labels': {name: root}, 'replay': root or None}."""
    from . import evaluate, train
    from .heatnet import decode, forward_np
    from .metrics import paired_bootstrap
    night = os.path.join(out_root, 'nights', day)
    os.makedirs(night, exist_ok=True)
    people = people_by_day(data['labels']['labels'], data['features'], data['shards'], uid)
    p = plan(people, day)
    report: dict = {'day': day, 'generated': datetime.now(HKT).isoformat(timespec='seconds'), 'plan': p,
                    'recipe': recipe['what'], 'notBuilt': NOT_BUILT}
    if p['why']:
        report['decision'] = f'nothing to do: {p["why"]}'
        return finish(report, night, out_root)

    runs = []
    for seed in seeds:
        out = os.path.join(night, 'models', f'seed{seed}')
        if not os.path.exists(os.path.join(out, 'model.json')):
            train.main(['--labels', data['labels'][recipe['labels']], '--features', data['features'], '--shards', data['shards'],
                        '--device', device, '--out', out, '--widths', recipe['widths'], '--seed', str(seed), '--val-day', p['check']]
                       + recipe['args'] + (['--epochs', '1', '--samples', '512'] if quick else [])
                       + [x for d in p['train'] for x in ('--train-day', d)])
        m = json.load(open(os.path.join(out, 'model.json')))
        v = m['metrics']['validation']
        runs.append({'seed': seed, 'model': os.path.join(out, 'model.json'), 'id': m['id'], 'checkF1': v['f1'],
                     'epoch': v['epoch'], 'threshold': m['threshold']})
    best = max(runs, key=lambda r: r['checkF1'] if r['checkF1'] is not None else -1)
    report['runs'], report['challenger'] = runs, best

    test = train.load_day(data['features'], data['labels']['labels'], data['shards'], uid, day)
    if not len(test['at']):
        report['decision'] = f'nothing to do: {day} has no usable frames (no background ready, or only near the day\'s ends)'
        return finish(report, night, out_root)
    scored: dict[str, dict] = {}
    frames: dict[str, list] = {}

    def add(name: str, predict) -> None:
        frames[name] = []
        s = evaluate.score(test, predict, frames_out=frames[name])
        scored[name] = {'all': s['all'], 'ci95': s['ci95'], 'byTrueCount': s['byTrueCount'], 'slices': slices(frames[name])}

    def model_points(doc: dict):
        return lambda i: [(x, y) for (x, y, _c) in decode(*forward_np(doc, test['x'][i]), doc['threshold'])]

    add('challenger', model_points(json.load(open(best['model']))))
    champion = registry.active()['champion']
    unfair = False
    if champion and os.path.exists(registry.path(champion)):
        doc = json.load(open(registry.path(champion)))
        unfair = saw(doc, day)            # a champion set by hand may have trained on tonight's test day
        add('champion', model_points(doc))
    replay = os.path.join(data['replay'], uid.replace(':', ''), f'{day}.edge.json') if data.get('replay') else None
    if replay and os.path.exists(replay):
        add('edge detector', evaluate.edge_points(data['replay'], uid, day, test['at']))
    live_name = 'champion' if 'champion' in scored else ('edge detector' if 'edge detector' in scored else None)
    diff = paired_bootstrap(frames[live_name], frames['challenger']) if live_name else None
    second = (Gate('G2 better on the test day', None, f'the champion trained on or chose with {day}: comparing on it is not fair')
              if live_name == 'champion' and unfair else g2(scored['challenger'], scored.get(live_name), live_name, diff))
    gates = [g1(p, set(people)), second,
             Gate('G3 the edge computes the same', None, 'checked when the edge takes the model: not built yet'),
             Gate('G4 a shadow day on the edge', None, 'not built yet: the edge has no ML detector mode')]
    report.update({'test': {'frames': len(test['at']), **scored}, 'live': live_name, 'difference': diff, 'championSawTestDay': unfair,
                   'gates': [asdict(g) for g in gates]})
    # G3 and G4 are not built, so the best a night can do is name a shadow candidate.
    decision = decide([g for g in gates if not g.name.startswith(('G3', 'G4'))])
    model_id = registry.add(best['model'])
    if decision.startswith('shadow candidate'):
        registry.set(f'night of {day}: {decision}', shadow=model_id)
    report['decision'] = decision
    report['registry'] = registry.active()
    return finish(report, night, out_root)


def finish(report: dict, night: str, out_root: str) -> dict:
    from .train import finite
    with open(os.path.join(night, 'report.json.tmp'), 'w') as f:
        json.dump(finite(report), f, indent=1, allow_nan=False)
    os.replace(os.path.join(night, 'report.json.tmp'), os.path.join(night, 'report.json'))
    with open(os.path.join(night, 'report.md'), 'w') as f:
        f.write(report_md(report, history(out_root)))
    return report


def history(out_root: str) -> list[dict]:
    """Every night's report so far, oldest first."""
    root = os.path.join(out_root, 'nights')
    out = []
    for day in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        f = os.path.join(root, day, 'report.json')
        if os.path.exists(f):
            out.append(json.load(open(f)))
    return out


def report_md(r: dict, nights: list[dict]) -> str:
    """The night's report for Kevin and P'Ing: only what was measured; anything else says so."""
    fmt = lambda v: 'not measured' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{v:.3f}'
    lines = [f'# Night of {r["day"]}', '', f'**Decision:** {r["decision"]}', '']
    t = r.get('test')
    if t:
        seen = ' (the champion trained on or chose with it)' if r.get('championSawTestDay') else ', which the challenger never trained on or chose with'
        lines += [f'## Scores on {r["day"]}{seen} ({t["frames"]} frames)', '',
                  '| Model | F1 [95%] | Precision | Recall | Count error | False people per empty frame | F1 with 2+ people |',
                  '|---|---|---|---|---|---|---|']
        for name in ('challenger', 'champion', 'edge detector'):
            s = t.get(name)
            if s is None:
                lines.append(f'| {name} | not measured | | | | | |')
                continue
            a, ci, sl = s['all'], s['ci95']['f1'], s['slices']
            lines.append(f'| {name} | {fmt(a["f1"])} [{fmt(ci[0])}, {fmt(ci[1])}] | {fmt(a["precision"])} | {fmt(a["recall"])} | '
                         f'{fmt(a["countMAE"])} | {fmt(sl["falsePerEmptyFrame"])} | {fmt(sl["busyF1"])} |')
        lines += ['', 'Agreement with the teacher on the rig: the photo-trained detectors, not people counted by hand.', '']
        lines += ['## Gates', ''] + [f'- **{g["name"]}:** {"passed" if g["passed"] else "failed" if g["passed"] is False else "not decided"}: {g["said"]}'
                                      for g in r['gates']] + ['']
        c = r['challenger']
        lines += ['## The challenger', '', f'Recipe: {r["recipe"]}. Trained on {", ".join(r["plan"]["train"])}; '
                  f'checked on {r["plan"]["check"]}. Three runs scored {", ".join(fmt(x["checkF1"]) for x in r["runs"])} '
                  f'on the check day; kept run {c["seed"] + 1} (model {c["id"]}, epoch {c["epoch"]}, threshold {c["threshold"]}).', '']
    rows = [n for n in nights if n.get('test')]
    if rows:
        lines += ['## Night by night', '', '| Night | Challenger F1 | Live | Live F1 | Decision |', '|---|---|---|---|---|']
        for n in rows:
            live = n.get('live')
            lines.append(f'| {n["day"]} | {fmt(n["test"]["challenger"]["all"]["f1"])} | {live or "none"} | '
                         f'{fmt(n["test"][live]["all"]["f1"]) if live else "not measured"} | {n["decision"].split(":")[0]} |')
        lines.append('')
    lines += ['## Not built yet', ''] + [f'- {x}' for x in r.get('notBuilt', [])] + ['']
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python3 -m tools.thermalml.nightly')
    p.add_argument('--day', help='the test day (default: the last finished day)')
    p.add_argument('--root', default='data/ml/nightly', help='nights/ and registry/ live here')
    p.add_argument('--shards', default='data/ml/shards')
    p.add_argument('--features', default='data/ml/features')
    p.add_argument('--labels', default='data/ml/job2/labels')
    p.add_argument('--labels-voted', default='data/ml/job2/labels-voted')
    p.add_argument('--replay', default='data/ml/replay', help='edge detector replays, when there is one for the day')
    p.add_argument('--device', default='cpu')
    p.add_argument('--quick', action='store_true', help='rehearsal: one short training epoch')
    p.add_argument('--set-champion', help='make this model.json the champion (after a milestone hand test) and stop')
    p.add_argument('--why', help='with --set-champion: the reason, for the registry history')
    a = p.parse_args(argv)
    registry = Registry(os.path.join(a.root, 'registry'))
    if a.set_champion:
        if not a.why:
            p.error('--set-champion needs --why')
        model_id = registry.add(a.set_champion)
        print(json.dumps(registry.set(a.why, champion=model_id), indent=1))
        return 0
    from .hpc_job import RECIPES, NIGHTLY_RECIPE
    os.makedirs(a.root, exist_ok=True)
    with open(os.path.join(a.root, 'lock'), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)    # one night at a time
        except BlockingIOError:
            raise SystemExit('another night is still running')
        t0 = time.time()
        r = run(a.day or yesterday(), {'shards': a.shards, 'features': a.features,
                                       'labels': {'labels': a.labels, 'labels-voted': a.labels_voted}, 'replay': a.replay},
                a.root, registry, RECIPES[NIGHTLY_RECIPE], a.device, quick=a.quick)
    print(r['decision'])
    print(f'report: {os.path.join(a.root, "nights", r["day"], "report.md")} ({(time.time() - t0) / 60:.1f} min)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
