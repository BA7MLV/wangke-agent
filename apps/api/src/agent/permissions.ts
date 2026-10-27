import type { AgentPolicy } from '../../../../packages/contracts/src/cloud.js';

/** Defense in depth for obvious destructive commands, not a shell security boundary.
 * Arbitrary code can hide its effects; host isolation remains enforced by the broker.
 */
export function shellPermission(policy: AgentPolicy, command: string, requiresApproval = false): 'allow' | 'ask' | 'deny' {
  if (policy.shell === 'deny') return 'deny';
  const destructive = /\b(?:rm|rmdir|unlink|shred|mkfs(?:\.\w+)?|wipefs|fdisk|parted|shutdown|reboot|poweroff)\b|\bdd\b[^\n]*\bof\s*=|\bgit\s+(?:clean|reset\s+--hard|push\b[^\n]*--force)|\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i.test(command);
  return policy.shell === 'ask' || requiresApproval || destructive ? 'ask' : 'allow';
}
