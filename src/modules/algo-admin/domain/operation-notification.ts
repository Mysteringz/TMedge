export const NOTIFICATION_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const NOTIFICATION_KINDS = ['sensor', 'training', 'firmware', 'parameter'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export interface OperationNotification {
  id: string; kind: NotificationKind; resourceId: string; label: string; outcome: string; occurredAt: number | null; href: string;
  classification?: 'active' | 'outcome'; detail?: string; deadlineAt?: number | null;
}
export type NotificationSourceState = 'available' | 'unavailable' | 'forbidden' | 'disabled';
export interface NotificationSummary { total: number; issues: number; status: string; observedAt: number | null; stale: boolean; active?: number; progress?: number }
export interface NotificationCandidate extends OperationNotification { windowAt: number }
export interface NotificationSourceView { items: NotificationCandidate[]; summary?: NotificationSummary; state?: NotificationSourceState }
export type NotificationRead = NotificationCandidate[] | NotificationSourceView | null;
export interface NotificationSnapshot { generatedAt: number; items: OperationNotification[]; sources: Record<NotificationKind, NotificationSourceState>; summaries: Partial<Record<NotificationKind, NotificationSummary>>; omittedCount: number; historyLimited: true }
