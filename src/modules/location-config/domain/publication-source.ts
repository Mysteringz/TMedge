import type { LocationDraft, PublishedLocationRevision } from './location-records.js';

/** Private receipt committed with the publication, independent of the draft's mutable storage. */
export interface SourceDraftPublication {
  draftId: string;
  draftRevision: number;
  basePublishedRevision: number | null;
}

export function parsePublicationSource(value: unknown, publishedRevision?: number): SourceDraftPublication | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Publication source is invalid.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || Object.keys(row).some(key => !['draftId', 'draftRevision', 'basePublishedRevision'].includes(key))
    || typeof row.draftId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.draftId)
    || !Number.isSafeInteger(row.draftRevision) || (row.draftRevision as number) < 1
    || (row.basePublishedRevision !== null && (!Number.isSafeInteger(row.basePublishedRevision) || (row.basePublishedRevision as number) < 0
      || (publishedRevision !== undefined && (row.basePublishedRevision as number) >= publishedRevision)))) {
    throw new TypeError('Publication source is invalid.');
  }
  return { draftId: row.draftId.toLowerCase(), draftRevision: row.draftRevision as number, basePublishedRevision: row.basePublishedRevision as number | null };
}

/** Older records predate receipts and retain their immediate-predecessor inheritance. */
export function publicationBaseRevision(revision: PublishedLocationRevision): number | null {
  return revision.sourceDraft ? revision.sourceDraft.basePublishedRevision : revision.revision === 0 ? null : revision.revision - 1;
}

/** A later edit of the retained draft is new work and must reappear in the draft list. */
export function isPublishedDraft(draft: LocationDraft, history: readonly PublishedLocationRevision[]): boolean {
  return history.some(revision => revision.locationId === draft.locationId && revision.createdBy === draft.creatorId
    && revision.sourceDraft?.draftId === draft.draftId && revision.sourceDraft.draftRevision === draft.draftRevision);
}
