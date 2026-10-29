import crypto from 'node:crypto';
import type { AgentPolicy, CloudConfig } from '@wangke/contracts/cloud';
import type { CloudConfiguration } from '../cloud/config.js';
import type { ProjectRepository, ProjectThread } from '../projects/repository.js';
import { ProjectError } from '../projects/files.js';

const slots = ['llmModel', 'visionModel', 'asrModel', 'decisionModel'] as const;
const definition = {
  type: 'function' as const,
  function: {
    name: 'settings',
    description: 'Read or change application configuration from the main Bot chat. get returns redacted settings and a revision. Every mutation requires expectedRevision from get; conflicts require a fresh read. set_model selects an already configured provider; set_budget changes the step limit. set_policy and set_provider ALWAYS require human approval, as does increasing the budget. set_provider updates an existing provider name, baseUrl or protocol; saved credentials are preserved and never returned. API keys and trusted Bot membership are managed by the human in Settings. Model changes apply to the next task; permission changes apply immediately.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set_model', 'set_budget', 'set_policy', 'set_provider'] },
        expectedRevision: { type: 'string' },
        slot: { type: 'string', enum: slots }, providerId: { type: 'string' }, model: { type: 'string' },
        maxSteps: { type: 'integer', minimum: 1, maximum: 1000 },
        policy: { type: 'object', additionalProperties: false, properties: {
          ...Object.fromEntries(['read', 'write', 'remove', 'shell'].map(key => [key, { type: 'string', enum: ['allow', 'ask', 'deny'] }])),
          network: { type: 'string', enum: ['allow', 'deny'] },
        } },
        provider: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string' }, baseUrl: { type: 'string' }, protocol: { type: 'string', enum: ['openai-chat', 'openai-responses', 'anthropic-messages'] },
        } },
      },
      required: ['action'],
    },
  },
};
const fields: Record<string, string[]> = {
  get: [], set_model: ['slot', 'providerId', 'model'], set_budget: ['maxSteps'], set_policy: ['policy'], set_provider: ['providerId', 'provider'],
};
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export class BotSettingsTools {
  constructor(private configuration: CloudConfiguration, private projects: ProjectRepository) {}
  definitions(thread: ProjectThread) { return !thread.project_id && thread.agent_id ? [definition] : []; }
  handles(name: string) { return name === 'settings'; }
  private revision(owner: string) {
    return crypto.createHash('sha256').update(JSON.stringify(this.configuration.get(owner, true))).digest('hex');
  }
  private validate(args: Record<string, unknown>, thread: ProjectThread) {
    if (thread.project_id || !thread.agent_id) throw new ProjectError('settings_access_denied', 403);
    this.projects.agent(thread.owner_id, thread.agent_id);
    const action = String(args.action);
    if (typeof args.action !== 'string' || !Object.hasOwn(fields, action) || Object.keys(args).some(key => !['action', ...(action === 'get' ? [] : ['expectedRevision']), ...fields[action]].includes(key))) throw new ProjectError('invalid_settings_arguments');
    if (action !== 'get' && args.expectedRevision !== this.revision(thread.owner_id)) throw new ProjectError('settings_conflict_read_again', 409);
    const config = this.configuration.get(thread.owner_id);
    if (action === 'set_model') {
      if (!slots.includes(args.slot as typeof slots[number]) || typeof args.providerId !== 'string' || typeof args.model !== 'string' || args.model.length > 200) throw new ProjectError('invalid_model_slot');
      if (args.model ? !config.providers.some(p => p.id === args.providerId) : args.providerId !== '' || args.slot === 'llmModel') throw new ProjectError('invalid_model_slot');
    }
    if (action === 'set_budget' && (!Number.isInteger(args.maxSteps) || Number(args.maxSteps) < 1 || Number(args.maxSteps) > 1000)) throw new ProjectError('invalid_policy');
    if (action === 'set_policy' && (!object(args.policy) || !Object.keys(args.policy).length || Object.entries(args.policy).some(([key, value]) =>
      typeof value !== 'string' || (key === 'network' ? !['allow', 'deny'].includes(value) : !['read', 'write', 'remove', 'shell'].includes(key) || !['allow', 'ask', 'deny'].includes(value))))) throw new ProjectError('invalid_policy');
    if (action === 'set_provider') {
      if (!config.providers.some(p => p.id === args.providerId) || !object(args.provider) || !Object.keys(args.provider).length || Object.keys(args.provider).some(key => !['name', 'baseUrl', 'protocol'].includes(key))) throw new ProjectError('invalid_provider');
      const p = args.provider;
      if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100)) throw new ProjectError('invalid_provider');
      if (p.protocol !== undefined && (typeof p.protocol !== 'string' || !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(p.protocol))) throw new ProjectError('invalid_provider');
      if (p.baseUrl !== undefined) {
        try {
          if (typeof p.baseUrl !== 'string') throw new Error();
          const url = new URL(p.baseUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { throw new ProjectError('invalid_provider_url'); }
      }
    }
    return config;
  }
  permission(_name: string, args: Record<string, unknown>, thread: ProjectThread, policy: AgentPolicy): 'allow' | 'ask' | 'deny' {
    const config = this.validate(args, thread);
    if (policy.read === 'deny') return 'deny';
    if (args.action === 'get') return policy.read;
    if (policy.write === 'deny') return 'deny';
    if (args.action === 'set_policy' || args.action === 'set_provider' || (args.action === 'set_budget' && Number(args.maxSteps) > config.policy.maxSteps)) return 'ask';
    return policy.write;
  }
  approval(args: Record<string, unknown>, thread: ProjectThread) {
    const config = this.configuration.get(thread.owner_id);
    const previous = args.action === 'set_provider' ? config.providers.find(p => p.id === args.providerId)
      : args.action === 'set_policy' ? config.policy
      : args.action === 'set_budget' ? { maxSteps: config.policy.maxSteps }
      : config[args.slot as typeof slots[number]];
    const { expectedRevision: _revision, ...change } = args;
    return `请求修改应用配置\n当前值：${JSON.stringify(previous, null, 2)}\n本次修改：${JSON.stringify(change, null, 2)}${args.action === 'set_provider' && object(args.provider) && args.provider.baseUrl !== undefined ? '\n更改 API 地址后，该连接保存的密钥和后续请求将发往新地址。' : ''}`;
  }
  parallelSafe(_name: string, args: Record<string, unknown>) { return args.action === 'get'; }
  execute(_name: string, args: Record<string, unknown>, thread: ProjectThread) {
    const config = this.validate(args, thread);
    if (args.action !== 'get') {
      if (args.action === 'set_model') config[args.slot as typeof slots[number]] = { providerId: args.providerId as string, model: args.model as string };
      if (args.action === 'set_budget') config.policy.maxSteps = args.maxSteps as number;
      if (args.action === 'set_policy') config.policy = { ...config.policy, ...args.policy as Partial<AgentPolicy> };
      if (args.action === 'set_provider') config.providers = config.providers.map(p => p.id === args.providerId ? { ...p, ...args.provider as Partial<CloudConfig['providers'][number]> } : p);
      this.configuration.save(thread.owner_id, config);
    }
    return JSON.stringify({ ...this.configuration.get(thread.owner_id), revision: this.revision(thread.owner_id) });
  }
}
