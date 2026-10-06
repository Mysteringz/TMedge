import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineRepository } from '../../algo/pipeline-repository.js';
import type { Pipeline } from '../../algo/types.js';

/** Stores named debugger pipelines as JSON in the existing local directory. */
export class JsonPipelineRepository implements PipelineRepository {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  load(name: string): Pipeline | null {
    const path = join(this.directory, `${name}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Pipeline;
    } catch {
      return null;
    }
  }

  save(name: string, pipeline: Pipeline): void {
    writeFileSync(join(this.directory, `${name}.json`), JSON.stringify({ ...pipeline, id: name }, null, 2));
  }

  list(): string[] {
    return readdirSync(this.directory).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''));
  }
}
