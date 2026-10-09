export type ReceiptState = 'requested' | 'sent' | 'acknowledged' | 'timed-out' | 'uncertain' | 'failed';
export interface CommandReceipt {
  id: string; uid: string; operation: string; sequence: number | null; boot: number | null;
  state: ReceiptState; requestedAt: number; updatedAt: number; message: string;
}
