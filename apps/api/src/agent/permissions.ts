import type { AgentPolicy } from '@wangke/contracts/cloud';

/** Defense in depth for obvious destructive commands, not a shell security boundary.
 * Arbitrary code can hide its effects; host isolation remains enforced by the broker.
 */
export function shellPermission(policy: AgentPolicy, command: string, requiresApproval = false, systemWrite = false): 'allow' | 'ask' | 'deny' {
  return shellDecision(policy, command, requiresApproval, systemWrite).permission;
}

export function shellDecision(policy: AgentPolicy, command: string, requiresApproval = false, systemWrite = false): { permission: 'allow' | 'ask' | 'deny'; reason?: 'policy' | 'destructive' | 'external' } {
  if (policy.shell === 'deny') return { permission: 'deny' };
  if (systemWrite && (policy.read === 'deny' || policy.write === 'deny')) return { permission: 'deny' };
  const destructive = /\b(?:rm|rmdir|unlink|shred|mkfs(?:\.\w+)?|wipefs|fdisk|parted|shutdown|reboot|poweroff)\b|\bdd\b[^\n]*\bof\s*=|\bgit\s+(?:clean|reset\s+--hard|push\b[^\n]*--force)|\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b|\bfind\b[^\n]*\s-delete\b|\brsync\b[^\n]*\s--delete\b|\.(?:unlink(?:Sync)?|rmdir(?:Sync)?|rm(?:Sync)?|remove|removedirs|rmtree)\s*\(/i.test(command);
  if (destructive) return policy.remove === 'deny' ? { permission: 'deny' } : { permission: 'ask', reason: 'destructive' };
  if (requiresApproval) return { permission: 'ask', reason: 'external' };
  if (systemWrite) return { permission: 'allow' };
  return policy.shell === 'ask' ? { permission: 'ask', reason: 'policy' } : { permission: 'allow' };
}
