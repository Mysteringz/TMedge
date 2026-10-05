import { buildRegistry, ConfigError, type NodeDef, type Registry } from '../../../edge/registry.js';
import type { RegistryNodeRecord, RegistryRepository } from '../repositories/registry-repository.js';

export interface ImportDiagnostic {
  code: 'duplicate_uid' | 'missing_floor' | 'missing_table' | 'invalid_coverage' | 'invalid_registry' | 'database_conflict';
  message: string;
  uid?: string;
}

export interface ImportPreview {
  valid: boolean;
  total: number;
  diagnostics: ImportDiagnostic[];
  insertable: number;
  unchanged: number;
}

export interface ImportResult extends ImportPreview {
  inserted: number;
}

export interface RegistrationExport {
  nodes: Array<{
    uid: string;
    label: string;
    floor?: string;
    pose?: NodeDef['pose'];
    owns: string[];
    simulated: boolean;
    rgb: boolean;
  }>;
}

/** Validates JSON against the existing geometry rules before persistence. */
export class RegistrationImportExport {
  constructor(private readonly repository: RegistryRepository) {}

  async preview(siteJson: unknown, nodesJson: unknown): Promise<ImportPreview> {
    const diagnostics = inspectInputs(siteJson, nodesJson);
    const parsed = parseNodeArray(nodesJson);
    if (parsed) {
      const counts = new Map<string, number>();
      for (const raw of parsed) {
        if (isObject(raw) && typeof raw.uid === 'string') {
          const uid = raw.uid.toLowerCase();
          counts.set(uid, (counts.get(uid) ?? 0) + 1);
        }
      }
      for (const [uid, count] of counts) {
        if (count > 1) diagnostics.push({ code: 'duplicate_uid', uid, message: `UID ${uid} appears ${count} times in the import` });
      }
    }

    let validated: RegistryNodeRecord[] = [];
    if (diagnostics.length === 0) {
      try {
        validated = nodesFromRegistry(buildRegistry(siteJson, nodesJson));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({ code: /cannot see all of its seats|coverage/i.test(message) ? 'invalid_coverage' : 'invalid_registry', message });
      }
    }

    const existing = await this.repository.listNodes();
    const byUid = new Map(existing.map((node) => [node.uid, node]));
    let unchanged = 0;
    let insertable = 0;
    for (const node of validated) {
      const current = byUid.get(node.uid);
      if (!current) insertable += 1;
      else if (sameNode(current, node)) unchanged += 1;
      else diagnostics.push({ code: 'database_conflict', uid: node.uid, message: `UID ${node.uid} already exists with different registration data` });
    }
    if (diagnostics.length === 0) {
      const merged = new Map(byUid);
      for (const node of validated) if (!merged.has(node.uid)) merged.set(node.uid, node);
      try {
        buildRegistry(siteJson, { nodes: [...merged.values()].map(toJsonNode) });
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        diagnostics.push({ code: 'database_conflict', message: error.message });
      }
    }
    const total = parsed?.length ?? 0;
    return { valid: diagnostics.length === 0, total, diagnostics, insertable, unchanged };
  }

  async import(siteJson: unknown, nodesJson: unknown, options: { dryRun?: boolean } = {}): Promise<ImportResult> {
    const preview = await this.preview(siteJson, nodesJson);
    if (options.dryRun || !preview.valid) return { ...preview, inserted: 0 };
    const nodes = nodesFromRegistry(buildRegistry(siteJson, nodesJson));
    const result = await this.repository.importNodes(nodes);
    return { ...preview, inserted: result.inserted, unchanged: result.unchanged };
  }

  /** Combines static geometry with the committed database node view. */
  async loadRegistry(siteJson: unknown): Promise<Registry> {
    const persistedNodes = await this.repository.listNodes();
    return buildRegistry(siteJson, { nodes: persistedNodes.map(toJsonNode) });
  }

  async export(siteJson: unknown): Promise<RegistrationExport> {
    const registry = await this.loadRegistry(siteJson);
    return { nodes: [...registry.nodes.values()].map((node) => ({
      uid: node.uid,
      label: node.label,
      ...(node.floorId === null ? {} : { floor: node.floorId }),
      ...(node.pose === null ? {} : { pose: node.pose }),
      owns: [...node.owns],
      simulated: node.simulated,
      rgb: node.rgb,
    })) };
  }
}

function inspectInputs(site: unknown, nodes: unknown): ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = [];
  if (!isObject(nodes) || !Array.isArray(nodes.nodes)) {
    return [{ code: 'invalid_registry', message: 'nodes.json.nodes: expected an array' }];
  }
  const floors = new Set<string>();
  const tables = new Map<string, string>();
  if (isObject(site) && Array.isArray(site.floors)) {
    for (const floor of site.floors) {
      if (!isObject(floor) || typeof floor.id !== 'string') continue;
      floors.add(floor.id);
      if (Array.isArray(floor.tables)) for (const table of floor.tables) {
        if (isObject(table) && typeof table.id === 'string') tables.set(table.id, floor.id);
      }
    }
  }
  for (const raw of nodes.nodes) {
    if (!isObject(raw)) continue;
    const uid = typeof raw.uid === 'string' ? raw.uid.toLowerCase() : undefined;
    if (typeof raw.floor === 'string' && !floors.has(raw.floor)) {
      diagnostics.push({ code: 'missing_floor', uid, message: `Node ${uid ?? '(unknown)'} references missing floor ${raw.floor}` });
    }
    if (Array.isArray(raw.owns)) for (const owned of raw.owns) {
      if (typeof owned === 'string' && !tables.has(owned)) {
        diagnostics.push({ code: 'missing_table', uid, message: `Node ${uid ?? '(unknown)'} references missing table ${owned}` });
      } else if (typeof owned === 'string' && typeof raw.floor === 'string' && tables.get(owned) !== raw.floor) {
        diagnostics.push({ code: 'missing_table', uid, message: `Table ${owned} is not on node ${uid ?? '(unknown)'} floor ${raw.floor}` });
      }
    }
  }
  if (diagnostics.length === 0) {
    try { buildRegistry(site, nodes); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({ code: /cannot see all of its seats|coverage/i.test(message) ? 'invalid_coverage' : 'invalid_registry', message });
    }
  }
  return diagnostics;
}

function parseNodeArray(value: unknown): unknown[] | null {
  return isObject(value) && Array.isArray(value.nodes) ? value.nodes : null;
}

function nodesFromRegistry(registry: Registry): RegistryNodeRecord[] {
  return [...registry.nodes.values()].map((node) => ({
    uid: node.uid,
    label: node.label,
    floorId: node.floorId,
    pose: node.pose,
    owns: [...node.owns],
    simulated: node.simulated,
    rgb: node.rgb,
  }));
}

function toJsonNode(node: RegistryNodeRecord): Record<string, unknown> {
  return {
    uid: node.uid, label: node.label,
    ...(node.floorId === null ? {} : { floor: node.floorId }),
    ...(node.pose === null ? {} : { pose: node.pose }),
    owns: [...node.owns], simulated: node.simulated, rgb: node.rgb,
  };
}

function sameNode(a: RegistryNodeRecord, b: RegistryNodeRecord): boolean {
  return a.uid === b.uid && a.label === b.label && a.floorId === b.floorId
    && JSON.stringify(a.pose) === JSON.stringify(b.pose)
    && [...a.owns].sort().join('\0') === [...b.owns].sort().join('\0')
    && a.simulated === b.simulated && a.rgb === b.rgb;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
