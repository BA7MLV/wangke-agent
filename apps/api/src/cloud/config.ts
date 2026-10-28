import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseStore } from '../storage/database.js';
import { DEFAULT_AGENT_POLICY, type CloudConfig, type CloudProvider } from '@wangke/contracts/cloud';
import { validateBudget } from '../agent/budget.js';
import { MODEL_FIELDS, modelReferenceIssues, type ModelSettingsIssue, type ModelSettingsUpdate, type ProviderSettingsUpdate } from '@wangke/contracts/model-settings';

export class ModelConfigurationError extends Error {
  constructor(message: string, readonly issues: ModelSettingsIssue[] = [], readonly status = 400) { super(message); }
}

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
      llmModel: { providerId: process.env.MODEL_API_KEY ? 'server' : '', model: process.env.MODEL_API_KEY ? process.env.MODEL_NAME || 'gpt-4o-mini' : '' },
      visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' },
      decisionModel: { providerId: '', model: '' },
      policy: { ...DEFAULT_AGENT_POLICY },
    };
    value.modelRevision = this.modelRevision(value);
    if (!secrets) value.providers = value.providers.map(({ apiKey, ...p }) => ({ ...p, configured: Boolean(apiKey) }));
    return value;
  }
  private modelRevision(value: CloudConfig) {
    // Keyed digest also changes on credential rotation without exposing a secret fingerprint.
    return crypto.createHmac('sha256', this.key).update(JSON.stringify([
      value.providers, ...MODEL_FIELDS.map((slot) => value[slot] ?? { providerId: '', model: '' }),
    ])).digest('hex');
  }
  saveModels(owner: string, update: ModelSettingsUpdate) {
    return this.store.transaction(() => this.saveModelsInTransaction(owner, update));
  }
  private saveModelsInTransaction(owner: string, update: ModelSettingsUpdate) {
    if (!update || typeof update.modelRevision !== 'string') throw new ModelConfigurationError('model_revision_required');
    const latest = this.get(owner, true);
    // Whitelist the scope: model settings can never overwrite policy, trust or budgets.
    return this.save(owner, { ...latest, modelRevision: update.modelRevision, providers: update.providers,
      llmModel: update.llmModel, visionModel: update.visionModel, asrModel: update.asrModel, decisionModel: update.decisionModel });
  }
  saveProvider(owner: string, id: string, update: ProviderSettingsUpdate) {
    return this.store.transaction(() => this.saveProviderInTransaction(owner, id, update));
  }
  private saveProviderInTransaction(owner: string, id: string, update: ProviderSettingsUpdate) {
    if (!update || typeof update.modelRevision !== 'string') throw new ModelConfigurationError('model_revision_required');
    if (!update.provider || update.provider.id !== id) throw new ModelConfigurationError('invalid_provider');
    const latest = this.get(owner, true);
    const exists = latest.providers.some((p) => p.id === id);
    const providers = exists ? latest.providers.map((p) => p.id === id ? update.provider : p) : [...latest.providers, update.provider];
    return this.save(owner, { ...latest, providers, modelRevision: update.modelRevision }, true);
  }
  save(owner: string, value: CloudConfig, preserveUnchangedInvalidModels = false) {
    return this.store.transaction(() => this.saveInTransaction(owner, value, preserveUnchangedInvalidModels));
  }
  private saveInTransaction(owner: string, value: CloudConfig, preserveUnchangedInvalidModels: boolean) {
    if (!value || !Array.isArray(value.providers) || value.providers.length > 30) throw new Error('invalid_config');
    const previous = this.get(owner, true);
    if (value.modelRevision !== undefined && value.modelRevision !== previous.modelRevision) {
      throw new ModelConfigurationError('model_settings_conflict', [], 409);
    }
    const ids = new Set<string>();
    const providers: CloudProvider[] = value.providers.map(p => {
      if (!p || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 ||
          !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(p.protocol)) throw new ModelConfigurationError('invalid_provider', [{ path: `providers.${p?.id ?? ''}`, reason: 'invalid_provider' }]);
      ids.add(p.id);
      let url: URL;
      try { url = new URL(p.baseUrl); }
      catch { throw new ModelConfigurationError('invalid_provider_url', [{ path: `providers.${p.id}.baseUrl`, reason: 'invalid_url' }]); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelConfigurationError('invalid_provider_url', [{ path: `providers.${p.id}.baseUrl`, reason: 'invalid_url' }]);
      // LAN-hosted models are supported. Bot endpoint changes must pass the exact-argument human approval in BotSettingsTools.
      const apiKey = p.apiKey === undefined ? previous.providers.find(old => old.id === p.id)?.apiKey ?? '' : p.apiKey;
      if (typeof apiKey !== 'string' || apiKey.length > 4096) throw new ModelConfigurationError('invalid_provider_key', [{ path: `providers.${p.id}.apiKey`, reason: 'invalid_key' }]);
      return { id: p.id, name: p.name.trim(), baseUrl: url.href.replace(/\/+$/, ''), protocol: p.protocol, apiKey,
        catalogId: typeof p.catalogId === 'string' ? p.catalogId.slice(0, 100) : '',
        serves: Array.isArray(p.serves) ? p.serves.filter(s => ['chat', 'vision', 'asr', 'decision'].includes(s)) : ['chat'] };
    });
    const decisionModel = value.decisionModel ?? { providerId: '', model: '' };
    const issues = modelReferenceIssues({ ...value, providers });
    const blocking = preserveUnchangedInvalidModels ? issues.filter((issue) => {
      const slot = issue.path as typeof MODEL_FIELDS[number];
      return JSON.stringify(value[slot]) !== JSON.stringify(previous[slot]);
    }) : issues;
    if (blocking.length) throw new ModelConfigurationError('invalid_model_slot', blocking);
    const policy = value.policy;
    if (!policy || !['read', 'write', 'remove', 'shell'].every(k => ['allow', 'ask', 'deny'].includes((policy as any)[k])) ||
        !['allow', 'deny'].includes(policy.network) || !Number.isInteger(policy.maxSteps) || policy.maxSteps < 1 || policy.maxSteps > 1000) throw new Error('invalid_policy');
    const cleanRef = (ref: { providerId: string; model: string }) => ref?.model
      ? { providerId: ref.providerId, model: ref.model } : { providerId: '', model: '' };
    const clean: CloudConfig = { providers, llmModel: cleanRef(value.llmModel), visionModel: cleanRef(value.visionModel), asrModel: cleanRef(value.asrModel),
      decisionModel: cleanRef(decisionModel),
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
    // Trust removes routine write/command prompts, not deletion or sensitive configuration approval.
    // Explicit prohibitions and the independent network switch still apply.
    const autonomous = Boolean(this.store.db.prepare(`SELECT 1 FROM gateway_bindings b JOIN gateway_accounts a ON a.id=b.account_id WHERE b.thread_id=? AND b.revoked=0 AND a.enabled=1 AND a.owner_id=? AND a.preset='autonomous'`).get(threadId, owner));
    const policy = { ...config.policy,
      write: trusted && config.policy.write === 'ask' ? 'allow' as const : config.policy.write,
      shell: trusted && config.policy.shell === 'ask' ? 'allow' as const : config.policy.shell };
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
