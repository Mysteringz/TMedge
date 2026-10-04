/**
 * Graph rules: what may connect to what, and in which order it runs.
 *
 * Connections are typed, and the editor refuses an illegal one rather than
 * discovering it at run time -- a debugger that can be wired into a state
 * where it silently computes nonsense is not a debugger.
 */
import { specOf } from './nodes.js';
import type { Pipeline } from './types.js';

export interface GraphProblem {
  where: string;
  message: string;
}

export function validate(p: Pipeline): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160;
  if (!object(p) || p.version !== 1 || !text(p.id) || !text(p.name) || typeof p.uid !== 'string' ||
      (p.uid !== '' && !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(p.uid)) ||
      !Number.isFinite(p.updatedAt) || !Array.isArray(p.nodes) || !Array.isArray(p.edges) ||
      p.nodes.length > 128 || p.edges.length > 512) {
    return [{ where: 'graph', message: 'invalid pipeline shape or size' }];
  }
  const nodeIds = new Set<string>();
  for (const n of p.nodes) {
    if (!object(n) || !text(n.id) || !text(n.type) || !text(n.name) || typeof n.enabled !== 'boolean' ||
        !object(n.position) || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y) || !object(n.params)) {
      return [{ where: 'graph', message: 'invalid node shape' }];
    }
    if (nodeIds.has(n.id)) problems.push({ where: n.id, message: 'duplicate node id' });
    nodeIds.add(n.id);
    const spec = specOf(n.type);
    for (const [key, value] of Object.entries(n.params)) {
      const param = spec?.params.find((s) => s.id === key);
      if (!param || typeof value !== 'number' || !Number.isFinite(value) || value < param.min || value > param.max) {
        problems.push({ where: n.id, message: `invalid parameter ${key}` });
      }
    }
  }
  const edgeIds = new Set<string>();
  for (const e of p.edges) {
    if (!object(e) || ![e.id, e.sourceNode, e.sourcePort, e.targetNode, e.targetPort].every(text)) {
      return [{ where: 'graph', message: 'invalid edge shape' }];
    }
    if (edgeIds.has(e.id)) problems.push({ where: e.id, message: 'duplicate edge id' });
    edgeIds.add(e.id);
  }
  const byId = new Map(p.nodes.map((n) => [n.id, n]));

  for (const n of p.nodes) {
    if (!specOf(n.type)) problems.push({ where: n.id, message: `unknown node type "${n.type}"` });
  }

  for (const e of p.edges) {
    const s = byId.get(e.sourceNode);
    const t = byId.get(e.targetNode);
    if (!s) { problems.push({ where: e.id, message: `no such node ${e.sourceNode}` }); continue; }
    if (!t) { problems.push({ where: e.id, message: `no such node ${e.targetNode}` }); continue; }
    const ss = specOf(s.type);
    const ts = specOf(t.type);
    const out = ss?.outputs.find((o) => o.id === e.sourcePort);
    const inp = ts?.inputs.find((i) => i.id === e.targetPort);
    if (!out) { problems.push({ where: e.id, message: `${s.type} has no output "${e.sourcePort}"` }); continue; }
    if (!inp) { problems.push({ where: e.id, message: `${t.type} has no input "${e.targetPort}"` }); continue; }
    if (out.type !== inp.type) {
      problems.push({
        where: e.id,
        message: `cannot connect ${out.type} to ${inp.type}: ${s.name}.${out.id} outputs ${out.type}, ${t.name}.${inp.id} expects ${inp.type}`,
      });
    }
  }

  // One source per input: a port fed twice is ambiguous, not a merge.
  const seen = new Set<string>();
  for (const e of p.edges) {
    const key = `${e.targetNode}.${e.targetPort}`;
    if (seen.has(key)) problems.push({ where: e.id, message: `${key} already has a source` });
    seen.add(key);
  }

  if (order(p) === null) problems.push({ where: 'graph', message: 'the graph has a cycle' });
  return problems;
}

/** Execution order, or null when the graph cannot be ordered. */
export function order(p: Pipeline): string[] | null {
  const incoming = new Map(p.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const e of p.edges) {
    if (!incoming.has(e.sourceNode) || !incoming.has(e.targetNode)) continue;
    incoming.set(e.targetNode, (incoming.get(e.targetNode) ?? 0) + 1);
    out.set(e.sourceNode, [...(out.get(e.sourceNode) ?? []), e.targetNode]);
  }
  const ready = [...incoming].filter(([, n]) => n === 0).map(([id]) => id);
  const sorted: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    sorted.push(id);
    for (const next of out.get(id) ?? []) {
      const left = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return sorted.length === p.nodes.length ? sorted : null;
}

/** The nodes `id` depends on, for running one node and its upstream only. */
export function upstreamOf(p: Pipeline, id: string): Set<string> {
  const need = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of p.edges) {
      if (need.has(e.targetNode) && !need.has(e.sourceNode)) {
        need.add(e.sourceNode);
        grew = true;
      }
    }
  }
  return need;
}
