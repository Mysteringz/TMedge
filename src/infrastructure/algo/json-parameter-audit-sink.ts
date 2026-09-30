import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry } from '../../algo/types.js';
import type { ParameterAuditSink } from '../../algo/params.js';

/** Appends debugger parameter changes to the existing JSONL audit file. */
export class JsonParameterAuditSink implements ParameterAuditSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
}
