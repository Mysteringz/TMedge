/**
 * The login screen's self-playing Snake, from the design prototype. It walks
 * the shortest path to the food only if it could still reach its own tail
 * afterwards; otherwise it heads for the neighbour with the most room.
 */
export const G = 14;
export const NN = G * G;

export interface SnakeState { snake: number[]; food: number }

const nbrs = (i: number): number[] => {
  const x = i % G, y = (i / G) | 0, r: number[] = [];
  if (y > 0) r.push(i - G);
  if (x < G - 1) r.push(i + 1);
  if (y < G - 1) r.push(i + G);
  if (x > 0) r.push(i - 1);
  return r;
};

function placeFood(snake: number[]): number {
  const occ = new Set(snake), free: number[] = [];
  for (let i = 0; i < NN; i++) if (!occ.has(i)) free.push(i);
  return free[Math.floor(Math.random() * free.length)] ?? 0;
}

export function newSnake(): SnakeState {
  const mid = 7 * G + 4, snake = [mid, mid - 1, mid - 2];
  return { snake, food: placeFood(snake) };
}

function bfs(start: number, goal: number, blocked: Set<number>): number[] | null {
  const prev = new Map<number, number>([[start, -1]]), q = [start];
  while (q.length) {
    const c = q.shift() as number;
    if (c === goal) break;
    for (const n of nbrs(c)) if (!prev.has(n) && !blocked.has(n)) { prev.set(n, c); q.push(n); }
  }
  if (!prev.has(goal)) return null;
  const p: number[] = [];
  for (let c = goal; c !== start; c = prev.get(c) ?? start) p.push(c);
  return p.reverse();
}

function space(start: number, blocked: Set<number>): number {
  const seen = new Set([start]), q = [start];
  while (q.length) {
    const c = q.shift() as number;
    for (const n of nbrs(c)) if (!seen.has(n) && !blocked.has(n)) { seen.add(n); q.push(n); }
  }
  return seen.size;
}

export function stepSnake(s: SnakeState): SnakeState {
  const { snake, food } = s, head = snake[0] ?? 0, body = new Set(snake.slice(0, -1));
  let next: number | null = null;
  const path = bfs(head, food, body);
  if (path && path[0] !== undefined) {
    const sim = [...path.slice().reverse(), ...snake].slice(0, snake.length + 1);
    const tail = sim[sim.length - 1];
    if (sim[0] !== undefined && tail !== undefined && bfs(sim[0], tail, new Set(sim.slice(0, -1)))) next = path[0];
  }
  if (next === null) {
    let best = -1;
    for (const n of nbrs(head)) {
      if (body.has(n)) continue;
      const sc = space(n, new Set([n, ...snake.slice(0, -1)]));
      if (sc > best) { best = sc; next = n; }
    }
  }
  if (next === null || snake.length >= NN - 1) return newSnake();
  const ate = next === food, ns = [next, ...snake];
  if (!ate) ns.pop();
  return { snake: ns, food: ate ? placeFood(ns) : food };
}
