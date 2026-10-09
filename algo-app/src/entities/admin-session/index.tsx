import { createContext, useContext } from 'react';

export interface AdminSession { user: string; role: 'viewer' | 'engineer' | 'admin'; namedAccount: boolean; capabilities: string[] }
export const AdminSessionContext = createContext<AdminSession | null>(null);
export function useCapability(capability: string): boolean { return useContext(AdminSessionContext)?.capabilities.includes(capability) ?? false; }
export function useAdminSession(): AdminSession | null { return useContext(AdminSessionContext); }
export function permissionChanged(status: number): void {
  if (status === 401 || status === 403) window.dispatchEvent(new CustomEvent('admin-access-change', { detail: status }));
}
