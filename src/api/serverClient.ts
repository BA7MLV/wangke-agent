import type {
  AgentProfileDto,
  BootstrapStatusDto,
  MessageDto,
  SseEvent,
  ThreadDto,
} from '@wangke/contracts';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

const API_ROOT = '/api/v1';

export class ServerApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'ServerApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ServerApiError(response.status, typeof body?.error === 'string' ? body.error : `http_${response.status}`);
  return body as T;
}

export interface ThreadDetail extends ThreadDto { messages: MessageDto[]; participants?: AgentProfileDto[]; approvals?: ApprovalDto[] }
export interface Session { authenticated: boolean; user: { id: string; name: string } | null }
export interface FileDto { id: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string }
export interface ApprovalDto { id: string; messageId: string; threadId: string; runId?: string | null; status: 'pending' | 'approved' | 'rejected'; createdAt: string; resolvedAt: string | null; resolution: string | null }

export const serverClient = {
  bootstrapStatus: () => request<BootstrapStatusDto>('/bootstrap/status'),
  bootstrapInitialize: (adminPassword: string, secret: string, adminName?: string) => request<{ initialized: true }>('/bootstrap/initialize', {
    method: 'POST', headers: { 'X-Bootstrap-Secret': secret }, body: JSON.stringify({ adminPassword, adminName }),
  }),
  login: (username: string, password: string) => request<{ user: Session['user'] }>('/auth/password/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  passkeyLoginOptions: () => request<PublicKeyCredentialRequestOptionsJSON>('/auth/passkey/login/options', { method: 'POST' }),
  passkeyLoginVerify: (response: AuthenticationResponseJSON) => request<{ verified: true; user: Session['user'] }>('/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify(response) }),
  passkeyRegisterOptions: () => request<PublicKeyCredentialCreationOptionsJSON>('/auth/passkey/register/options', { method: 'POST' }),
  passkeyRegisterVerify: (response: RegistrationResponseJSON) => request<{ verified: true }>('/auth/passkey/register/verify', { method: 'POST', body: JSON.stringify(response) }),
  session: () => request<Session>('/auth/session'),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  agents: () => request<{ agents: AgentProfileDto[] }>('/agents'),
  createAgent: (profile: { name: string; role?: string; systemPrompt?: string; avatar?: string }) => request<AgentProfileDto>('/agents', { method: 'POST', body: JSON.stringify(profile) }),
  threads: () => request<{ threads: ThreadDto[] }>('/threads'),
  createThread: (title?: string) => request<ThreadDto>('/threads', { method: 'POST', body: JSON.stringify({ mode: 'bot', title }) }),
  thread: (id: string) => request<ThreadDetail>(`/threads/${encodeURIComponent(id)}`),
  stopThread: (id: string) => request<{ stopped: number }>(`/threads/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  sendMessage: (id: string, content: string, clientNonce: string) => request<MessageDto & { deduplicated?: boolean }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ clientNonce, role: 'user', kind: 'text', content }) }),
  sendAttachment: (id: string, content: string, clientNonce: string) => request<MessageDto & { deduplicated?: boolean }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ clientNonce, role: 'user', kind: 'attachment', content }) }),
  uploadFile: (file: File) => request<FileDto>('/files', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Mime': file.type || 'application/octet-stream' } }),
  deleteFile: (id: string) => request<{ deleted: true }>(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  react: (messageId: string, reaction: string) => request<{ messageId: string; reaction: string; active: boolean }>(`/messages/${encodeURIComponent(messageId)}/reactions`, { method: 'POST', body: JSON.stringify({ reaction }) }),
  approvals: (id: string) => request<ApprovalDto>(`/approvals/${encodeURIComponent(id)}`),
  resolveApproval: (id: string, approved: boolean, resolution?: string) => request<ApprovalDto>(`/approvals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ approved, resolution }) }),
  async events(id: string, after: number, onEvent: (event: SseEvent, id: number) => void, signal?: AbortSignal) {
    const response = await fetch(`${API_ROOT}/threads/${encodeURIComponent(id)}/events?after=${after}`, { credentials: 'include', headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(after) }, signal });
    if (!response.ok || !response.body) throw new ServerApiError(response.status, `events_${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let eventId = after; let eventType = '';
    const consume = (block: string) => {
      let data = '';
      let nextType = '';
      let nextId = eventId;
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) {
          const parsed = Number(line.slice(3).trim());
          if (Number.isSafeInteger(parsed) && parsed >= 0) nextId = parsed;
        } else if (line.startsWith('event:')) nextType = line.slice(6).trim();
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
      }
      if (!data || !nextType) return;
      try {
        const parsed = JSON.parse(data);
        eventId = nextId;
        eventType = nextType;
        onEvent({ type: eventType, ...parsed } as SseEvent, eventId);
      } catch {
        // Reconnect from the last valid cursor if a malformed event is received.
      }
    };
    for (;;) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const blocks = buffer.split('\n\n'); buffer = blocks.pop() ?? ''; blocks.forEach(consume); }
    if (buffer.trim()) consume(buffer);
  },
};
