/** One small document, read whole and replaced whole. */
export interface DocumentStore<T> {
  /** The current document. Callers must not change what they are handed. */
  read(): T;
  /** Changes a private copy and commits it; nothing is written if `change` throws. */
  update<R>(change: (draft: T) => R): R;
}
