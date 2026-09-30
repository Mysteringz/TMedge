export type RolloutTarget =
  | { kind: 'node'; uid: string }
  | { kind: 'floor'; floorId: string }
  | { kind: 'all' };
