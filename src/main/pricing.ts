// What a model's tokens would cost at the providers' API list prices, for Home's Agent tab. An estimate only: a Claude
// or ChatGPT plan is billed as the plan, not per token.
//
// USD per million tokens, checked 2026-11-05 against platform.claude.com/docs/en/about-claude/pricing and
// developers.openai.com/api/docs/pricing (standard tier, global routing). [input, 5-minute cache write, cache read,
// output]; a 1-hour cache write is twice the input price on every Claude model, and OpenAI has no cache write.
// The first pattern that matches wins, so narrower ids come first.
type Price = [input: number, cacheWrite: number, cacheRead: number, output: number];
const PRICES: [RegExp, Price][] = [
  [/^claude-(fable|mythos)-5-1\b/, [10, 12.5, 0.25, 50]],
  [/^claude-(fable|mythos)-5\b/, [10, 12.5, 1, 50]],
  [/^claude-opus-5-5\b/, [4, 5, 0.2, 20]],
  [/^claude-opus-(5|4-[5-8])\b/, [5, 6.25, 0.5, 25]],
  [/^claude-opus-4(-[01])?\b/, [15, 18.75, 1.5, 75]],
  [/^claude-sonnet-5-5\b/, [2, 2.5, 0.1, 10]],
  [/^claude-sonnet-5\b/, [2, 2.5, 0.2, 10]],
  [/^(claude-sonnet-4|claude-3-7-sonnet)/, [3, 3.75, 0.3, 15]],
  // Claude Haiku 5.5 is dearer for prompts over 100,000 tokens (see HAIKU_LONG).
  [/^claude-haiku-5-5\b/, [0.1, 0.125, 0.01, 0.5]],
  [/^claude-haiku-4-5\b/, [1, 1.25, 0.1, 5]],
  [/^claude-3-5-haiku/, [0.8, 1, 0.08, 4]],
  [/^gpt-6-luna\b/, [0.1, 0, 0.01, 0.5]],
  [/^gpt-6-sol\b/, [2, 0, 0.2, 10]],
  [/^gpt-6-astra\b/, [10, 0, 1, 50]],
  [/^gpt-5\.6-terra\b/, [2, 0, 0.2, 12]],
  [/^gpt-5\.6-luna\b/, [0.2, 0, 0.02, 1.2]],
  [/^gpt-5\.6-sol\b/, [4, 0, 0.4, 20]],
  [/^gpt-5\.3-codex\b/, [1.75, 0, 0.175, 14]],
];
const HAIKU_LONG: { over: number; price: Price } = { over: 100_000, price: [0.5, 0.625, 0.05, 2.5] };
// Claude Code can log the short names it was started with.
const ALIASES: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

function priceOf(model: unknown): Price | null {
  const id = String(model || '').toLowerCase().trim();
  const name = ALIASES[id] || id;
  return PRICES.find(([re]) => re.test(name))?.[1] ?? null;
}

// One message's (or step's) cost in USD, or null when the model has no known price.
// t: { input, output, cacheWrite (all cache writes), cacheWrite1h (the part of those kept for an hour), cacheRead }.
// fast: Claude's fast mode, twice the standard price.
interface Tokens { input?: number; output?: number; cacheWrite?: number; cacheWrite1h?: number; cacheRead?: number }
function costOf(model: unknown, t: Tokens, { fast = false }: { fast?: boolean } = {}): number | null {
  let p = priceOf(model);
  if (!p) return null;
  const input = t.input || 0, output = t.output || 0, cacheRead = t.cacheRead || 0;
  const write = t.cacheWrite || 0, write1h = Math.min(write, t.cacheWrite1h || 0);
  if (p === priceOf('claude-haiku-5-5') && input + write + cacheRead > HAIKU_LONG.over) p = HAIKU_LONG.price;
  const [pin, pw5, pread, pout] = p;
  const usd = (input * pin + (write - write1h) * pw5 + write1h * pin * 2 + cacheRead * pread + output * pout) / 1e6;
  return fast ? usd * 2 : usd;
}

export { priceOf, costOf };
