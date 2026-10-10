import type { NotificationRead } from '../domain/operation-notification.js';

export interface NotificationQueries {
  training(owner: string, now?: number): Promise<NotificationRead> | NotificationRead;
  firmware(now?: number): Promise<NotificationRead> | NotificationRead;
  sensor?(now: number): Promise<NotificationRead> | NotificationRead;
  parameter?(now: number): Promise<NotificationRead> | NotificationRead;
}
