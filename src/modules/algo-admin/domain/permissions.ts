export const ADMIN_ROLES = ['viewer', 'operator', 'engineer', 'admin'] as const;
export type AdminRole = typeof ADMIN_ROLES[number];
export const CAPABILITIES = ['algo.read', 'algo.write', 'training.read', 'training.write', 'firmware.read', 'firmware.write', 'nodes.write', 'nodes.admin', 'accounts.manage'] as const;
export type Capability = typeof CAPABILITIES[number];
export interface AdminPrincipal { name: string; role: AdminRole; namedAccount: boolean; capabilities: Capability[] }
export function isAdminRole(value: unknown): value is AdminRole { return ADMIN_ROLES.some((role) => role === value); }
export function principal(name: string, role: AdminRole, namedAccount = true): AdminPrincipal {
  const capabilities: Capability[] = ['algo.read', 'training.read', 'firmware.read'];
  if (role !== 'viewer') capabilities.push('algo.write', 'training.write', 'nodes.write');
  if (role === 'engineer' || role === 'admin') capabilities.push('firmware.write', 'nodes.admin');
  if (role === 'admin' && namedAccount) capabilities.push('accounts.manage');
  return { name, role, namedAccount, capabilities };
}
/** Unknown commands cannot acquire operator authority through a raw endpoint. */
export function nodeCommandCapability(body: unknown): Capability {
  const op = typeof body === 'object' && body !== null && 'op' in body ? body.op : undefined;
  return ['set', 'reset-bg', 'identify', 'save'].includes(String(op)) ? 'nodes.write' : 'nodes.admin';
}
