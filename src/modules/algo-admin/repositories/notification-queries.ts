import type { NotificationCandidate } from '../domain/operation-notification.js';

export interface NotificationQueries {
  training(owner: string): Promise<NotificationCandidate[] | null> | NotificationCandidate[] | null;
  firmware(): Promise<NotificationCandidate[] | null> | NotificationCandidate[] | null;
}
