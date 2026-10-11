export * from './model/types.ts';
export { useWorkspace, type WorkspaceState } from './model/use-workspace.ts';
export { workspaceApi, WorkspaceRequestError } from './api/workspace-api.ts';
export { buildIndex, search, KIND_LABEL, type SearchEntry, type SearchKind, type SearchTarget, type SensorSource } from './lib/search.ts';
