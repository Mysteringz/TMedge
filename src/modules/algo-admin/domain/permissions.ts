export const ADMIN_ROLES = ['viewer', 'operator', 'engineer', 'admin'] as const;
export type AdminRole = typeof ADMIN_ROLES[number];
export const CAPABILITIES = ['algo.read', 'algo.write', 'training.read', 'training.write', 'firmware.read', 'firmware.write', 'nodes.write', 'nodes.admin', 'accounts.manage'] as const;
export type Capability = typeof CAPABILITIES[number];
/**
 * What somebody works on. A label for the team to find and assign each other
 * by; it grants nothing. Access is the AdminRole above and only that.
 */
export const TEAM_ROLES = ['ml', 'frontend', 'backend', 'firmware', 'hardware'] as const;
export type TeamRole = typeof TEAM_ROLES[number];
export function isTeamRole(value: unknown): value is TeamRole { return TEAM_ROLES.some((role) => role === value); }
/** A valid list of team roles, in the canonical order and without repeats; null if it is anything else. */
export function teamRolesOf(value: unknown): TeamRole[] | null {
  if (!Array.isArray(value) || value.length > TEAM_ROLES.length || !value.every(isTeamRole)) return null;
  return TEAM_ROLES.filter((role) => value.includes(role));
}
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
