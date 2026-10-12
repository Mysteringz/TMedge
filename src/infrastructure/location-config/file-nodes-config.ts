import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseNodesConfig, type NodesConfigV2 } from '../../modules/location-config/domain/nodes-config.js';
import { atomicReplaceFile, verifyAndSyncFile, type AtomicFileOperations, type FileDurability } from './atomic-file-write.js';

export interface NodesConfigCommitOutcome {
  kind: 'committed';
  durability: FileDurability;
  revision: number;
  contentSha256: string;
}

export function readNodesConfig(path: string): NodesConfigV2 {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const result = parseNodesConfig(parsed);
  if (result.kind !== 'v2') throw new Error('NODES_CONFIG must be upgraded to schemaVersion 2 before registry writes.');
  return result.document;
}

export function atomicWriteNodesConfig(path: string, document: NodesConfigV2, operations: AtomicFileOperations = {}): NodesConfigCommitOutcome {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  const write = atomicReplaceFile(path, bytes, mode, '.nodes-config', operations);
  return { kind: 'committed', durability: write.durability, revision: document.revision, contentSha256: write.sha256 };
}

export function recoverNodesConfig(path: string, expectedRevision: number, expectedSha256: string, operations: AtomicFileOperations = {}): void {
  verifyAndSyncFile(path, expectedSha256, (bytes) => {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const result = parseNodesConfig(parsed);
    if (result.kind !== 'v2' || result.document.revision !== expectedRevision) {
      throw new Error('NODES_CONFIG no longer contains the expected committed revision.');
    }
  }, operations);
}
