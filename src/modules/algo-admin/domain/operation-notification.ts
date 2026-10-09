export const NOTIFICATION_WINDOW_MS = 7 * 24 * 60 * 60_000;
export interface OperationNotification {
  id: string; kind: 'training' | 'firmware'; resourceId: string; label: string; outcome: string; occurredAt: number | null; href: string;
}
export type NotificationSourceState = 'available' | 'unavailable' | 'forbidden';
export interface NotificationCandidate extends OperationNotification { windowAt: number }
export interface NotificationSnapshot { generatedAt: number; items: OperationNotification[]; sources: { training: NotificationSourceState; firmware: NotificationSourceState }; historyLimited: true }
