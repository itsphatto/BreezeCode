// @agent mentions in a prompt: "@Claude make the UI @Codex make the API" becomes one task per agent.
// Plain functions with no Electron, so test/mentions.test.js can cover them.

export interface Agent { id: string; name: string; found?: boolean }

const SHORT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', local: 'Local' };

const shortName = ({ id, name }: Pick<Agent, 'id' | 'name'>): string => SHORT_NAMES[id] || name;

// Lowercase names a mention may use: the short name, the full name and the id.
const mentionNames = (agent: Agent): string[] => [...new Set([shortName(agent), agent.name, agent.id].map(n => String(n).toLowerCase()))];

// A mention is "@" at the start or after whitespace, then a known name (longest first) that ends at a non-word character.
// Mentions of agents that are not found, or of no agent, go into `unknown` and stay in the text.
function parseMentions(text: unknown, agents: Agent[]): { shared: string; tasks: { agentId: string; text: string }[]; unknown: string[] } {
  const src = String(text ?? '');
  const names: { name: string; agent: Agent }[] = [];
  for (const agent of agents) for (const name of mentionNames(agent)) names.push({ name, agent });
  names.sort((a, b) => b.name.length - a.name.length);

  const marks: { at: number; end: number; agentId: string }[] = [];
  const unknown: string[] = [];
  const re = /(^|\s)@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const at = m.index + m[1].length;
    const rest = src.slice(at + 1);
    const lower = rest.toLowerCase();
    const hit = names.find(n => lower.startsWith(n.name) && !/[\w-]/.test(rest[n.name.length] || ''));
    if (hit && hit.agent.found) {
      const end = at + 1 + hit.name.length;
      marks.push({ at, end, agentId: hit.agent.id });
      re.lastIndex = end;
    } else if (hit) {
      unknown.push(rest.slice(0, hit.name.length));
    } else {
      const word = /^[\w-]+/.exec(rest);
      if (word) unknown.push(word[0]);
    }
  }

  const shared = src.slice(0, marks.length ? marks[0].at : src.length).trim();
  const byAgent = new Map<string, string[]>();
  marks.forEach((mark, i) => {
    const body = src.slice(mark.end, i + 1 < marks.length ? marks[i + 1].at : src.length).trim();
    if (!byAgent.has(mark.agentId)) byAgent.set(mark.agentId, []);
    if (body) byAgent.get(mark.agentId)!.push(body);
  });
  const tasks = [...byAgent].map(([agentId, parts]) => ({ agentId, text: parts.join('\n\n') }));
  return { shared, tasks, unknown };
}

export { parseMentions, shortName, mentionNames };
