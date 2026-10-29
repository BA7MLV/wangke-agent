import type { AgentPolicy } from '@wangke/contracts/cloud';

/** Defense in depth for obvious destructive commands, not a shell security boundary.
 * Arbitrary code can hide its effects; host isolation remains enforced by the broker.
 */
export function shellPermission(policy: AgentPolicy, command: string, requiresApproval = false): 'allow' | 'ask' | 'deny' {
  return shellDecision(policy, command, requiresApproval).permission;
}

export function shellDecision(policy: AgentPolicy, command: string, requiresApproval = false): { permission: 'allow' | 'ask' | 'deny'; reason?: 'policy' | 'destructive' | 'external' } {
  if (policy.shell === 'deny') return { permission: 'deny' };
  const destructive = /\b(?:rm|rmdir|unlink|shred|mkfs(?:\.\w+)?|wipefs|fdisk|parted|shutdown|reboot|poweroff)\b|\bdd\b[^\n]*\bof\s*=|\bgit\s+(?:clean|reset\s+--hard|push\b[^\n]*--force)|\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i.test(command);
  if (destructive) return { permission: 'ask', reason: 'destructive' };
  if (requiresApproval) return { permission: 'ask', reason: 'external' };
  return policy.shell === 'ask' ? { permission: 'ask', reason: 'policy' } : { permission: 'allow' };
}
