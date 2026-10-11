import { readFileSync, statSync } from 'node:fs';
import { LIMITS, type Knowledge, type KnowledgeSource } from '../../modules/assistant/domain/assistant.js';

/**
 * The knowledge base as a file in the release (config/ai-knowledge.md), read
 * again when it changes. It ships with the code it describes, so a deploy
 * that changes how the system works also changes what the assistant says.
 */
export class KnowledgeFile implements KnowledgeSource {
  private cached: Knowledge | null = null;
  private seen = '';
  constructor(readonly path: string) {}

  read(): Knowledge {
    const stat = statSync(this.path, { bigint: true });
    const stamp = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    if (this.cached && stamp === this.seen) return this.cached;
    // Too large to leave the model room to answer is an error, not something to truncate quietly.
    if (stat.size > BigInt(LIMITS.knowledgeBytes)) throw new Error('knowledge base too large');
    const text = readFileSync(this.path, 'utf8').trim();
    if (!text) throw new Error('knowledge base is empty');
    this.cached = { text, updatedAt: Number(stat.mtimeMs) };
    this.seen = stamp;
    return this.cached;
  }
}
