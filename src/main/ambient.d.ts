// The emmet package is "type": "module", so under CommonJS resolution its own typings are not picked up. This is the
// part main uses (emmet.ts): expand() with a syntax, a markup/stylesheet type and a field formatter.
declare module 'emmet' {
  export interface ExpandConfig {
    syntax?: string;
    type?: 'markup' | 'stylesheet';
    options?: Record<string, unknown>;
  }
  const expand: (abbr: string, config?: ExpandConfig) => string;
  export default expand;
}
