// The API agents that run on Breeze's own agent loop (OpenAI-style chat completions with tool calls): a local
// server (Ollama, LM Studio…), Gemini, OpenRouter and DeepSeek. What differs between them lives here: the address, where
// the key is kept, which models are listed, how much context to send, and how their errors read.
// Plain functions with no Electron, so test/llmproviders.test.js can cover them.

export type LlmProviderId = 'local' | 'gemini' | 'openrouter' | 'deepseek';
export const LLM_PROVIDER_IDS: LlmProviderId[] = ['local', 'gemini', 'openrouter', 'deepseek'];

export interface LlmProvider {
  id: LlmProviderId;
  name: string;
  vendor: string;
  url: string | null;      // null: found by probing the usual local addresses
  keyUrl: string | null;   // where to get a key
  getUrl: string;          // the "Get" button on the Setup card
  keySecret: string;       // the name the key is saved under in the encrypted secrets file
  needsKey: boolean;
  sub: string;             // the Setup card's line under the name
  billedBy: string | null; // who bills the usage; null runs on this computer
}

export const LLM_PROVIDERS: Record<LlmProviderId, LlmProvider> = {
  local: {
    id: 'local', name: 'Ollama', vendor: 'Ollama, LM Studio or any OpenAI-compatible server', url: null, keyUrl: null,
    getUrl: 'https://ollama.com/download', keySecret: 'llmKey', needsKey: false,
    sub: 'Finds Ollama or LM Studio running on this computer', billedBy: null,
  },
  gemini: {
    id: 'gemini', name: 'Gemini', vendor: 'Google', url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey', getUrl: 'https://aistudio.google.com/apikey', keySecret: 'geminiKey', needsKey: true,
    sub: 'Free tier · needs a Google account', billedBy: 'Google',
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', vendor: 'OpenRouter', url: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys', getUrl: 'https://openrouter.ai/keys', keySecret: 'openrouterKey', needsKey: true,
    sub: 'One key for hundreds of models · pay as you go', billedBy: 'OpenRouter',
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek API', vendor: 'DeepSeek', url: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys', getUrl: 'https://platform.deepseek.com/api_keys', keySecret: 'deepseekKey', needsKey: true,
    sub: 'Pay as you go · needs a DeepSeek account', billedBy: 'DeepSeek',
  },
};

export function isLlmAgent(id: unknown): id is LlmProviderId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(LLM_PROVIDERS, id);
}

export interface ModelList { models: string[]; contexts: Record<string, number> }

type Loose = any; // server JSON; each provider adds its own fields

// The models worth offering from a /models reply. Throws when none are left.
export function filterModels(provider: LlmProviderId, json: unknown): ModelList {
  const j: Loose = json || {};
  const list: Loose[] = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  const contexts: Record<string, number> = {};
  let models: string[];
  if (provider === 'gemini') {
    // Only chat models: embeddings, speech, image and live (audio) models can't run the agent loop. Gemini 1.x
    // and 2.x still show in the list, but Google refuses them for new users, so they're left out too.
    models = list.map(m => String(m?.id || m?.name || '').replace(/^models\//, ''))
      .filter(id => /gemini/i.test(id) && !/(embed|tts|image|live|audio|aqa)/i.test(id) && !/^gemini-[12](?:\.\d+)?-/i.test(id));
  } else if (provider === 'openrouter') {
    // The agent needs tool calls; models that can't make them are left out.
    const usable = list.filter(m => m?.id && Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'));
    models = usable.map(m => String(m.id));
    for (const m of usable) if (Number(m.context_length) > 0) contexts[m.id] = Number(m.context_length);
  } else {
    models = list.map(m => m?.id || m?.name).filter(Boolean).map(String);
    if (provider === 'deepseek') for (const m of list) if (m?.id && Number(m.context_window) > 0) contexts[m.id] = Number(m.context_window);
  }
  models = [...new Set(models)];
  if (!models.length) {
    throw new Error(provider === 'local'
      ? 'The server has no models yet. Download one first, for example: ollama pull llama3.1'
      : `${LLM_PROVIDERS[provider].name} offered no models this agent can use.`);
  }
  return { models, contexts };
}

// The model picked on connecting: the newest Gemini Flash model when there is one. Gemini's free tier allows it,
// and on OpenRouter (which lists its newest, often premium, models first) it is a cheap one that calls tools well.
// On DeepSeek it is deepseek-flash, its cheap one.
export function defaultModel(provider: LlmProviderId, models: string[]): string {
  if (provider === 'deepseek') return models.includes('deepseek-flash') ? 'deepseek-flash' : models[0];
  if (provider !== 'local') {
    const flash = provider === 'gemini' ? /^gemini-(\d+(?:\.\d+)?)-flash$/ : /^google\/gemini-(\d+(?:\.\d+)?)-flash$/;
    let best: string | null = null, bestVersion = -1;
    for (const m of models) {
      const v = flash.exec(m);
      if (v && Number(v[1]) > bestVersion) { best = m; bestVersion = Number(v[1]); }
    }
    if (best) return best;
  }
  return models[0];
}

// OpenRouter's model list is public, so a wrong key still lists models: its /key endpoint is what checks the key.
export function keyCheckPath(provider: LlmProviderId): string | null {
  return provider === 'openrouter' ? '/key' : null;
}

// A saved cloud entry with a newer model list, or null when nothing changed. The chosen model stays as it is,
// unless the provider no longer offers it: then it moves to the one picked on connecting (the newest Flash).
export function refreshedEntry(saved: { model: string; models: string[]; contexts?: Record<string, number> }, fresh: ModelList, provider?: LlmProviderId): { model: string; models: string[]; contexts: Record<string, number> } | null {
  const gone = !!provider && !!fresh.models.length && !fresh.models.includes(saved.model);
  const same = saved.models.length === fresh.models.length && saved.models.every((m, i) => m === fresh.models[i])
    && JSON.stringify(saved.contexts ?? {}) === JSON.stringify(fresh.contexts);
  if (same && !gone) return null;
  return { model: gone ? defaultModel(provider!, fresh.models) : saved.model, models: fresh.models, contexts: fresh.contexts };
}

// Cloud models take far more than this, but every turn resends the history: a cap keeps free quotas and bills small.
const CLOUD_CONTEXT = 128000;
// The model's context window in tokens. Ollama runs models with a small context unless it was raised on the
// server; other local servers usually allow more. `override` (the saved llmContext) only applies to local servers.
export function contextWindow(provider: LlmProviderId, o: { url: string; model?: string | null; contexts?: Record<string, number>; override?: number }): number {
  if (provider === 'local') return o.override || (/:11434\b/.test(o.url) ? 4096 : 8192);
  if (provider === 'openrouter' || provider === 'deepseek') {
    const n = o.model ? o.contexts?.[o.model] : undefined;
    return n ? Math.min(n, CLOUD_CONTEXT) : CLOUD_CONTEXT;
  }
  return CLOUD_CONTEXT;
}

// An error the user can act on. It keeps the HTTP status (`status`) so callers can tell a key or quota problem
// from a model that can't take tools.
export function friendlyError(provider: LlmProviderId, status: number, body: unknown): Error & { status: number } {
  const p = LLM_PROVIDERS[provider];
  const b: Loose = Array.isArray(body) ? body[0] : body;
  const raw = b?.error?.message || (typeof b?.error === 'string' ? b.error : '') || `The server answered with status ${status}`;
  let text = String(raw);
  if (provider !== 'local' && (status === 401 || status === 403)) text = `${p.name} rejected the key. Check it at ${p.keyUrl?.replace(/^https:\/\//, '')}.`;
  else if (provider === 'gemini' && status === 429) text = "Gemini's free limit is used up for now. Wait a minute, or add billing in Google AI Studio.";
  else if (provider === 'openrouter' && status === 429) text = 'OpenRouter is rate-limiting this model. Wait a minute or pick another model.';
  else if (provider === 'openrouter' && status === 402) text = 'OpenRouter needs credits. Add them at openrouter.ai/credits.';
  else if (provider === 'deepseek' && status === 402) text = 'Your DeepSeek balance is used up. Add funds at platform.deepseek.com/top_up.';
  else if (provider === 'deepseek' && status === 429) text = 'DeepSeek is getting requests too fast. Wait a minute and try again.';
  return Object.assign(new Error(text), { status });
}

// Headers a provider asks for beyond the key. OpenRouter uses these to credit the app.
export function extraHeaders(provider: LlmProviderId): Record<string, string> {
  return provider === 'openrouter' ? { 'HTTP-Referer': 'https://breezecode.site/', 'X-Title': 'Breeze Code' } : {};
}

// DeepSeek thinks before it answers, and on a request with tools it refuses (400) a conversation whose earlier thinking
// (reasoning_content) isn't sent back. The other providers neither need it nor expect it.
export function keepsReasoning(provider: LlmProviderId): boolean {
  return provider === 'deepseek';
}

// Body fields that turn thinking off (or as far down as it goes), for a short job such as a commit message.
// Gemini 3 can't turn thinking off; low is its least.
export function withoutThinkingBody(provider: LlmProviderId): Record<string, unknown> {
  if (provider === 'deepseek') return { thinking: { type: 'disabled' } };
  if (provider === 'gemini') return { reasoning_effort: 'low' };
  return {};
}

// Body fields for each step of the agent loop. Gemini 3 thinks at high by default, which makes every tool step
// take minutes; low is plenty for reading and editing files. Google also says a temperature under 1.0 makes
// Gemini 3 loop, so it keeps its own default. The others run cool, for steady tool calls.
export function agentBody(provider: LlmProviderId): Record<string, unknown> {
  return provider === 'gemini' ? { reasoning_effort: 'low' } : { temperature: 0.2 };
}
