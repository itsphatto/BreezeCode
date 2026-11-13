// Pure logic for the status bar's tools item (renderToolStatus in setup.ts). No DOM, no globals from other files.

// Which detected tools (by id, from sys:detect) run or build a file with this extension.
const TOOLS_FOR_EXT: Record<string, string[]> = {
  js: ['node'], mjs: ['node'], cjs: ['node'], jsx: ['node'], ts: ['node'], tsx: ['node'], mts: ['node'], cts: ['node'],
  c: ['cc'], h: ['cc'], cc: ['cc'], cpp: ['cc'], cxx: ['cc'], hpp: ['cc'], hh: ['cc'],
  py: ['python'], pyw: ['python'], ipynb: ['python'], cs: ['dotnet'], java: ['java'], rs: ['rust', 'cargo'], lua: ['lua'], php: ['php'],
  sql: ['sqlite'], go: ['go'], rb: ['ruby'], kt: ['kotlin'], kts: ['kotlin'], swift: ['swift'], dart: ['dart'], zig: ['zig'],
  scala: ['scala'], ex: ['elixir'], exs: ['elixir'], hs: ['haskell'], r: ['r'], pl: ['perl'], pm: ['perl'], groovy: ['groovy'],
};
const toolLabel = (name: string) => name.replace('.js', '').replace('C/C++', 'C');

// The open file's own tools (ready or missing), then any required tool that is missing. Nothing to say: "Tools ready".
function toolStatus(tools: { id: string; name: string; found: boolean; optional?: boolean }[], ext: string): { text: string; warn: boolean } {
  const ids = TOOLS_FOR_EXT[ext.toLowerCase()] ?? [];
  const own = ids.map(id => tools.find(t => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);
  const broken = tools.filter(t => !t.optional && !t.found && !own.includes(t));
  const shown = [...own, ...broken];
  if (!shown.length) return { text: 'Tools ready', warn: false };
  return { text: shown.map(t => `${toolLabel(t.name)} ${t.found ? 'ready' : 'missing'}`).join(' · '), warn: shown.some(t => !t.found) };
}
