// Pure logic for the Explorer tree (explorer.ts). No DOM, no globals from other files.

// Compiled output and the source each comes from: a .js file is TypeScript output when a .ts or .tsx of the same
// name sits beside it.
const GENERATED_FROM: Record<string, string[]> = { js: ['ts', 'tsx'], jsx: ['tsx'], mjs: ['mts'], cjs: ['cts'] };

// The names, in one folder's listing, of files compiled from a TypeScript file beside them, with their source maps.
// The Explorer hides these unless Show Generated Files is on.
function generatedFiles(entries: { name: string; dir: boolean }[]): Set<string> {
  const files = new Set(entries.filter(e => !e.dir).map(e => e.name.toLowerCase()));
  const out = new Set<string>();
  for (const e of entries) {
    if (e.dir) continue;
    const m = /^(.+)\.(js|jsx|mjs|cjs)(\.map)?$/i.exec(e.name);
    if (m && GENERATED_FROM[m[2].toLowerCase()].some(src => files.has(`${m[1]}.${src}`.toLowerCase()))) out.add(e.name);
  }
  return out;
}
