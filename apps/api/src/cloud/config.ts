import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseStore } from '../storage/database.js';
import { DEFAULT_AGENT_POLICY, type CloudConfig, type CloudProvider } from '../../../../packages/contracts/src/cloud.js';
import { validateBudget } from '../agent/budget.js';

export class CloudConfiguration {
  private key: Buffer;
  constructor(private store: DatabaseStore, directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = path.join(directory, 'credentials.key');
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('invalid_credentials_key');
  }
  seal(value: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(value: string) {
    const bytes = Buffer.from(value, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  get(owner: string, secrets = false): CloudConfig {
    const row = this.store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get(owner) as { value: string } | undefined;
    const value: CloudConfig = row ? JSON.parse(this.open(row.value)) : {
      providers: process.env.MODEL_API_KEY ? [{ id: 'server', name: '服务端模型', baseUrl: process.env.MODEL_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.MODEL_API_KEY, protocol: 'openai-chat', catalogId: '', serves: ['chat', 'vision', 'asr'] }] : [],
      llmModel: { providerId: 'server', model: process.env.MODEL_NAME || (process.env.MODEL_API_KEY ? 'gpt-4o-mini' : '') },
      visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' },
      policy: { ...DEFAULT_AGENT_POLICY },
    };
    if (!secrets) value.providers = value.providers.map(({ apiKey, ...p }) => ({ ...p, configured: Boolean(apiKey) }));
    return value;
  }
  save(owner: string, value: CloudConfig) {
    if (!value || !Array.isArray(value.providers) || value.providers.length > 30) throw new Error('invalid_config');
    const previous = this.get(owner, true);
    const ids = new Set<string>();
    const providers: CloudProvider[] = value.providers.map(p => {
      if (!p || !/^[\w-]{1,64}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || p.name.length > 100 ||
          !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(p.protocol)) throw new Error('invalid_provider');
      ids.add(p.id);
      const url = new URL(p.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_provider_url');
      // The administrator may deliberately configure a LAN-hosted model. Never accept an endpoint from a task/model.
      const apiKey = p.apiKey === undefined ? previous.providers.find(old => old.id === p.id)?.apiKey ?? '' : p.apiKey;
      if (typeof apiKey !== 'string' || apiKey.length > 4096) throw new Error('invalid_provider_key');
      return { id: p.id, name: p.name, baseUrl: url.href.replace(/\/+$/, ''), protocol: p.protocol, apiKey,
        catalogId: typeof p.catalogId === 'string' ? p.catalogId.slice(0, 100) : '',
        serves: Array.isArray(p.serves) ? p.serves.filter(s => ['chat', 'vision', 'asr'].includes(s)) : ['chat'] };
    });
    for (const slot of ['llmModel', 'visionModel', 'asrModel'] as const) {
      const ref = value[slot];
      if (!ref || typeof ref.model !== 'string' || ref.model.length > 200 || typeof ref.providerId !== 'string' ||
          (ref.model && !ids.has(ref.providerId))) throw new Error('invalid_model_slot');
    }
    const policy = value.policy;
    if (!policy || !['read', 'write', 'remove', 'shell'].every(k => ['allow', 'ask', 'deny'].includes((policy as any)[k])) ||
        !['allow', 'deny'].includes(policy.network) || !Number.isInteger(policy.maxSteps) || policy.maxSteps < 1 || policy.maxSteps > 1000) throw new Error('invalid_policy');
    const clean: CloudConfig = { providers, llmModel: value.llmModel, visionModel: value.visionModel, asrModel: value.asrModel,
      ...(value.botBudget ? { botBudget: validateBudget(value.botBudget) } : {}),
      policy: { read: policy.read, write: policy.write, remove: policy.remove, shell: policy.shell, network: policy.network, maxSteps: policy.maxSteps },
      trustedAgentIds: Array.isArray(value.trustedAgentIds) ? value.trustedAgentIds.filter(id => typeof id === 'string' && Boolean(this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=?').get(id, owner))).slice(0, 100) : [] };
    this.store.db.prepare('INSERT INTO cloud_config(owner_id,value,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(owner, this.seal(JSON.stringify(clean)), new Date().toISOString());
    this.audit(owner, 'configuration.updated', { providers: providers.map(p => p.id), policy });
    return this.get(owner);
  }
  policy(owner: string, threadId: string) {
    const config = this.get(owner);
    const agents = this.store.db.prepare('SELECT agent_id FROM thread_participants WHERE thread_id=?').all(threadId) as Array<{ agent_id: string }>;
    const trusted = agents.length > 0 && agents.every(a => config.trustedAgentIds?.includes(a.agent_id));
    // Explicit prohibitions and the independent network switch still apply to trusted agents.
    const autonomous = Boolean(this.store.db.prepare(`SELECT 1 FROM gateway_bindings b JOIN gateway_accounts a ON a.id=b.account_id WHERE b.thread_id=? AND b.revoked=0 AND a.enabled=1 AND a.owner_id=? AND a.preset='autonomous'`).get(threadId, owner));
    const policy = { ...config.policy, shell: trusted && config.policy.shell === 'ask' ? 'allow' as const : config.policy.shell };
    if (autonomous) for (const key of ['read', 'write', 'shell'] as const) if (policy[key] === 'ask') policy[key] = 'allow';
    return policy;
  }
  taskPolicy(owner: string, taskId: string) {
    const task = this.store.db.prepare('SELECT t.parent_step_id,r.thread_id FROM cloud_tasks t LEFT JOIN runs r ON r.id=t.parent_run_id WHERE t.id=? AND t.owner_id=?').get(taskId, owner) as any;
    const policy = task?.thread_id ? this.policy(owner, task.thread_id) : this.get(owner).policy;
    if (task?.parent_step_id && this.store.db.prepare("SELECT 1 FROM approvals WHERE step_id=? AND status='approved'").get(task.parent_step_id)) return { ...policy, read: policy.read === 'ask' ? 'allow' as const : policy.read, write: policy.write === 'ask' ? 'allow' as const : policy.write };
    return policy;
  }
  audit(owner: string, action: string, detail: unknown) {
    appendAudit(this.store, owner, action, detail);
  }
}
import { appendAudit } from '../storage/audit.js';
