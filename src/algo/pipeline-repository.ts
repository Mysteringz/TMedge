import type { Pipeline } from './types.js';

/** Reads and writes named debugger pipeline documents. */
export interface PipelineRepository {
  load(name: string): Pipeline | null;
  save(name: string, pipeline: Pipeline): void;
  list(): string[];
}
