/* ================= Discord ================= */
// Rich Presence through the Discord app on this computer (main.js talks to it); updates are coalesced.
const discordSince = Date.now();
let discordTimer: TimeoutId | undefined;
let discordLive = false;   // connected and showing
// Status words shown when "Show file and project name" is off: nothing about the work, just a verb.
const DISCORD_WORDS = `Absorbing Abstracting Accelerating Accessorizing Acclimating Accomplishing Accumulating Achieving Activating Actualizing Adapting Adjusting Admiring Advancing Advising Aggregating Aiming Aligning Allocating Alphabetizing Amalgamating Amassing Amplifying Analyzing Anchoring Animating Annotating Anticipating Appraising Appreciating Approximating Architecting Arranging Articulating Ascending Assembling Assessing Assimilating Assorting Attuning Auditing Augmenting Authoring Automating Awakening Apprehending Ambling Annealing Appending Archiving Arpeggiating Accompanying Abseiling Airbrushing Alchemizing Amending Ascertaining Attaching Acquiring Arbitrating Babbling Backpacking Baking Balancing Ballooning Bantering Barnstorming Bartering Basking Batching Beaming Beatboxing Beavering Bedazzling Beekeeping Befriending Beholding Benchmarking Bewitching Biking Billowing Birdwatching Blazing Blending Blooming Blossoming Blueprinting Bobbing Boogying Bootstrapping Bouncing Braiding Brainstorming Branching Breezing Brewing Bridging Brightening Broiling Brushing Bubbling Budding Budgeting Buffering Building Bundling Burnishing Bustling Buzzing Barbecuing Basting Blanching Braising Browning Brining Bopping Breakdancing Burrowing Bounding Bicycling Boating Beading Binding Blacksmithing Bookbinding Brazing Bookkeeping Briefing Blogging Bowling Bouldering Breathing Blinking Broadcasting Bebopping Calculating Calibrating Calligraphing Campaigning Camping Canoeing Capturing Caramelizing Carving Cascading Cataloging Catapulting Celebrating Centering Cerebrating Channeling Charting Chiseling Choreographing Chugging Churning Circling Clarifying Classifying Climbing Clustering Coalescing Coaxing Coding Cogitating Collaborating Collating Collecting Coloring Combining Combobulating Comparing Compiling Composing Composting Computing Concentrating Conceptualizing Concocting Conducting Configuring Conjuring Connecting Considering Constructing Consulting Contemplating Converging Converting Cooking Coordinating Correlating Crafting Cranking Creating Crocheting Crunching Crystallizing Cultivating Curating Customizing Conceiving Conferring Conjecturing Chopping Curing Chanting Crooning Chirping Cooing Crackling Cresting Cartwheeling Commuting Cruising Cantering Coasting Careening Casting Caching Catalyzing Centrifuging Compressing Containerizing Charming Checking Communicating Copywriting Correcting Corresponding Captioning Chronicling Copyediting Caving Constellating Chilling Cozying Chuckling Cheering Clapping Carrying Cementing Charging Chasing Clearing Coiling Completing Condensing Conserving Consolidating Contouring Conveying Cushioning Cycling Cartooning Caricaturing Certifying Dabbling Dancing Dashing Daydreaming Debating Debugging Deciphering Decoding Decorating Deducing Defragmenting Delegating Deliberating Delighting Delving Designing Detailing Detangling Detecting Determining Developing Devising Diagnosing Diagramming Digesting Digging Dipping Discerning Discovering Dissecting Distilling Diving Divining Doodling Drafting Drawing Dreaming Drifting Drumming Dusting Dicing Drizzling Darning Dyeing Darting Dawdling Dillydallying Decrypting Deploying Diffusing Digitizing Debouncing Diffing Dowsing Discombobulating Dictating Documenting Dribbling Decompressing Decluttering Defining Delivering Demystifying Depicting Deriving Describing Dispatching Displaying Distributing Diversifying Dovetailing Downloading Duplicating Easing Echoing Editing Effervescing Elaborating Elevating Elucidating Embarking Embellishing Embroidering Emerging Emulating Enchanting Encoding Energizing Engineering Engraving Enhancing Enlightening Enriching Envisioning Equalizing Estimating Evaluating Evolving Examining Excavating Executing Exercising Experimenting Explaining Exploring Extracting Extrapolating Eddying Expediting Embossing Enameling Etching Electrifying Encrypting Enumerating Evaporating Emailing Embedding Emboldening Encapsulating Encircling Enlarging Ensuring Entwining Equipping Establishing Exchanging Expanding Expressing Extending Fabricating Factoring Fashioning Fathoming Fermenting Fetching Fiddling Figuring Filtering Finagling Fishing Flexing Flickering Floating Flourishing Flowing Fluttering Focusing Folding Foraging Forecasting Forging Formulating Fostering Framing Freewheeling Frolicking Frosting Flipping Frying Fizzing Flaring Frothing Foaming Ferrying Felting Firing Formatting Flowering Fencing Fielding Filing Finalizing Forwarding Footnoting Feasting Fastening Fitting Fixing Forming Fortifying Fueling Furnishing Fusing Flibbertigibbeting Galloping Gardening Gathering Gauging Generating Germinating Gilding Gleaming Gliding Glimmering Glistening Glowing Grafting Grappling Gravitating Grazing Grilling Grinding Grokking Grooming Grooving Growing Guessing Guiding Gleaning Grasping Garnishing Glazing Grating Galumphing Gamboling Gusting Glittering Gushing Gallivanting Globetrotting Glassblowing Gluing Graphing Golfing Gazing Giggling Grinning Gearing Glimpsing Grouping Guarding Hammering Handcrafting Harmonizing Harnessing Harvesting Hashing Hatching Herding Hiking Honing Hopping Hovering Humming Hustling Hydrating Hypothesizing Hoeing Hibernating Hurtling Hemming Highlighting Headlining Hobnobbing Honking Hurdling Handling Hinging Hoisting Hooking Ideating Identifying Igniting Illuminating Illustrating Imagining Imbuing Improvising Incubating Indexing Inferring Infusing Initializing Innovating Inspecting Inspiring Integrating Interlacing Interpreting Interweaving Intuiting Inventing Investigating Invigorating Iterating Inquiring Introspecting Icing Inking Inlaying Interpolating Ionizing Interviewing Inventorying Itemizing Imprinting Improving Inflating Informing Installing Interconnecting Interlocking Introducing Jamming Jazzing Jiggling Jitterbugging Jogging Joining Jotting Journaling Journeying Juggling Jumping Juxtaposing Juicing Julienning Jiving Jaunting Jetting Jetsetting Jesting Joking Jousting Justifying Kayaking Kindling Kneading Knitting Knotting Kerning Labeling Lacing Landscaping Lassoing Lathering Laughing Launching Layering Leafing Learning Leavening Leaping Levitating Lifting Lingering Linking Listening Loading Locating Logging Looping Lounging Ladling Lettering Lacquering Laminating Linting Listing Lazing Leveling Leveraging Lining Lollygagging Machining Manifesting Mapping Marinating Marveling Masterminding Matching Materializing Maximizing Meandering Measuring Meditating Mellowing Memorizing Mending Mentoring Merging Mesmerizing Metabolizing Mingling Miniaturizing Mixing Modeling Modulating Molding Monitoring Morphing Mosaicking Moseying Motivating Mulling Multiplying Musing Mustering Marshaling Mashing Mincing Munching Moonwalking Mulching Migrating Misting Marching Mountaineering Marbling Magnetizing Multiplexing Memoizing Minifying Managing Magnifying Maintaining Marking Mediating Melding Mirroring Mobilizing Moderating Mounting Navigating Negotiating Nestling Networking Nibbling Nodding Noodling Normalizing Noticing Nourishing Nudging Nurturing Nesting Needlepointing Noting Narrating Napping Narrowing Notching Observing Optimizing Orbiting Orchestrating Organizing Orienting Originating Oscillating Outlining Overhauling Opining Orienteering Onboarding Opening Outfitting Overlaying Packing Paddling Painting Parsing Partitioning Pathfinding Patterning Pedaling Peeking Percolating Perfecting Perusing Philosophizing Photographing Piecing Piloting Pinpointing Pioneering Pirouetting Pivoting Plaiting Planning Planting Playing Pleating Plotting Plucking Plumbing Poaching Polishing Pollinating Pondering Pontificating Popping Positioning Postulating Practicing Prancing Predicting Preparing Pressing Prioritizing Probing Processing Programming Projecting Prospecting Prototyping Pruning Puttering Puzzling Perceiving Peeling Pickling Plating Pureeing Proofing Picnicking Photosynthesizing Purring Pouncing Parachuting Paragliding Patching Patchworking Planing Potting Printing Papermaking Parallelizing Pinging Polymerizing Prefetching Profiling Polyfilling Prestidigitating Pootling Paginating Paraphrasing Presenting Proofreading Publishing Punning Pitching Pottering Pairing Parceling Pasting Piling Pinning Placing Plugging Pointing Pooling Portioning Powering Prepping Priming Producing Propelling Propping Protecting Providing Pumping Purifying Quantifying Quarrying Questing Questioning Quilting Querying Quantizing Quipping Quickening Radiating Rafting Rambling Ranking Rationalizing Reading Realigning Reasoning Recalibrating Recapping Reckoning Recollecting Reconciling Rediscovering Refactoring Refining Reflecting Reformulating Regrouping Rehearsing Reimagining Rejuvenating Relaxing Remixing Rendering Reorganizing Repotting Researching Resolving Restoring Retrieving Reticulating Revamping Reviewing Revising Revitalizing Rhyming Riffing Ripening Roaming Roasting Rolling Rotating Rowing Ruminating Running Realizing Recalling Rethinking Reducing Rising Rocking Raking Rooting Romping Rippling Racing Rappelling Rocketing Riveting Rasterizing Recursing Recompiling Refreshing Replicating Routing Recording Reporting Reformatting Rewording Rewriting Recounting Reminiscing Riddling Rejoicing Resting Rebuilding Recharging Reconnecting Recycling Redesigning Redrawing Refilling Reflowing Refocusing Rejigging Relaying Remodeling Renewing Reorienting Repairing Rephrasing Replenishing Reshaping Resizing Restocking Restructuring Retooling Retracing Reworking Rewiring Rigging Rinsing Rounding Sailing Sampling Sauteing Savoring Scaffolding Scanning Scheming Schlepping Scouting Scribbling Scripting Sculpting Searching Seasoning Seeding Sequencing Shaping Sharpening Shimmering Shimmying Shuffling Sifting Simmering Simplifying Simulating Singing Sketching Skating Skimming Sleuthing Smoothing Snorkeling Soaring Solving Sorting Sowing Sparkling Spelunking Spinning Spiraling Splicing Sprouting Stacking Steeping Stewing Stitching Storyboarding Strategizing Streamlining Strolling Strumming Structuring Studying Summarizing Surfing Surveying Sussing Swirling Synchronizing Synthesizing Scrutinizing Speculating Surmising Scrambling Searing Sieving Slicing Steaming Stirring Stuffing Sweetening Spritzing Sprinkling Snacking Serenading Swaying Swinging Syncopating Sashaying Skipping Strutting Scampering Scurrying Shining Splashing Swashbuckling Surging Scooting Skateboarding Skiing Skydiving Sledding Snowboarding Snowshoeing Sprinting Swimming Sauntering Sanding Sawing Screenprinting Sewing Silversmithing Soldering Stamping Staining Stenciling Scrapbooking Shading Sandboxing Scaling Scheduling Serializing Sharding Spawning Splitting Stabilizing Streaming Subdividing Syncing Spellcasting Stargazing Summoning Smooshing Schmoozing Skedaddling Scoping Sourcing Specifying Stapling Storytelling Subtitling Somersaulting Stretching Spacewalking Snoozing Sunning Smiling Sealing Securing Selecting Separating Setting Settling Shepherding Sizing Snapping Softening Spacing Spanning Sparking Spooling Spreading Squaring Staging Steadying Steering Stocking Straightening Strengthening Stringing Supporting Sweeping Switching Tabulating Tackling Tailoring Tallying Tangoing Tapping Tasting Teaching Tempering Testing Theorizing Thinking Threading Tidying Tinkering Toasting Toggling Tracing Tracking Trailblazing Transcribing Transforming Translating Transmuting Traveling Trekking Triangulating Trimming Troubleshooting Tuning Tweaking Twirling Typing Tenderizing Tossing Tending Tilling Transplanting Twinkling Trickling Teleporting Tobogganing Touring Traipsing Trotting Tiling Tinsmithing Texturing Tessellating Tokenizing Transcoding Transpiling Traversing Templating Theming Typesetting Transfiguring Tagging Timeboxing Totaling Tumbling Telescoping Tapering Tethering Thickening Tightening Tinting Topping Transferring Transmitting Tucking Twining Tiptoeing Twisting Uncovering Understanding Unearthing Unfolding Unfurling Unifying Unlocking Unpacking Unraveling Unscrambling Untangling Unwinding Updating Upgrading Uplifting Unzipping Uploading Underlining Upholstering Uncorking Unboxing Unbundling Unspooling Unveiling Unwrapping Upcycling Ushering Validating Vaulting Venturing Verifying Vibing Visualizing Vocalizing Voyaging Varnishing Veneering Vectorizing Versioning Virtualizing Versifying Volleying Waddling Wafting Wandering Waltzing Warming Weaving Whisking Whistling Whittling Whirring Winding Wizarding Wondering Woodworking Working Wrangling Wrapping Writing Weighing Whipping Warbling Wiggling Wobbling Watering Weeding Whirling Wayfaring Windsurfing Whizzing Whooshing Welding Woodcarving Watercoloring Wireframing Wibbling Wordsmithing Wisecracking Warping Waving Winking Washing Weatherproofing Wedging Wending Whetting Widening Wiring Yodeling Yachting Zigzagging Zipping Zooming Zesting Zhuzhing Ziplining`.split(' ');
// One word per session, re-rolled whenever what you're doing changes (working / chatting / editing).
let discordWord = '';
let discordWordKind = '';
function discordPickWord(kind: string): string {
  if (!discordWord || discordWordKind !== kind) {
    discordWord = DISCORD_WORDS[Math.floor(Math.random() * DISCORD_WORDS.length)];
    discordWordKind = kind;
  }
  return discordWord;
}
function discordActivity(): DiscordActivity {
  const working = Object.values(agentsDef).find(a => a.status === 'working');
  const inBox = appState.mode === 'box';
  const file = active ? baseName(active) : null;
  if (!appState.discordDetails) {
    const details = discordPickWord(working ? 'agents' : inBox ? 'box' : 'editor');
    return { details, state: 'Breeze Code', start: discordSince, dev: appState.devMode };
  }
  // Only the file you are in and where you are: agent roles (Builder, Planner…) and their tasks stay private.
  let details = inBox ? 'Chatting in Breeze Space' : 'Idle';
  if (!inBox && file) details = `Editing ${file}`;
  const lang = !inBox && active ? langOf(active)[1] : '';
  const where = rootInfo ? `in ${rootInfo.name}` : 'Breeze Code';
  const icon = !inBox && active ? discordIcon(active) : undefined;
  return { details, state: lang ? `${lang} · ${where}` : where, start: discordSince, icon, lang: lang || undefined, dev: appState.devMode };
}
// The file's language icon for the big presence picture (names of the PNGs main.js links to, from vscord's set).
const DISCORD_ICONS: Record<string, string> = {
  html: 'html', htm: 'html', xml: 'xml', svg: 'svg', vue: 'vue', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  styl: 'stylus', pcss: 'postcss',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', jsonc: 'json',
  json5: 'json', hjson: 'hjson',
  md: 'markdown', markdown: 'markdown', mdx: 'markdownx', rst: 'restructuredtext', adoc: 'asciidoc', tex: 'tex',
  latex: 'tex', typ: 'typst', txt: 'text', log: 'log', ipynb: 'jupyter',
  py: 'python', pyw: 'python', pyx: 'cython', java: 'java', jar: 'jar', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  sc: 'scala', groovy: 'groovy', gradle: 'gradle', clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  rs: 'rust', go: 'go', zig: 'zig', nim: 'nim', odin: 'odin', v: 'v', d: 'd', cr: 'crystal', gleam: 'gleam',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', mm: 'objective-c',
  cs: 'csharp', csx: 'csharp', csproj: 'csproj', fs: 'fsharp', fsx: 'fsharp', vb: 'vb', xaml: 'xaml',
  cshtml: 'razor', razor: 'razor', cu: 'cuda', asm: 'assembly', s: 'assembly', wasm: 'wasm', wat: 'wasm',
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', hlsl: 'hlsl', metal: 'metal', ino: 'arduino',
  rb: 'ruby', erb: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', luau: 'luau', r: 'r', jl: 'julia',
  dart: 'dart', swift: 'swift', ex: 'elixir', exs: 'elixir', heex: 'heex', erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell', elm: 'elm', ml: 'ocaml', mli: 'ocaml', re: 'reasonml', rei: 'reasonml',
  purs: 'purescript', rkt: 'racket', lisp: 'lisp', el: 'lisp', coffee: 'coffee', hx: 'haxe', mojo: 'mojo',
  gd: 'godot', rpy: 'renpy', qml: 'qml', vala: 'vala', lean: 'lean', agda: 'agda', sol: 'solidity',
  f90: 'fortran', f95: 'fortran', cob: 'cobol', pas: 'pascal', vhd: 'vhdl', vhdl: 'vhdl', sv: 'systemverilog',
  ahk: 'ahk', au3: 'autoit', applescript: 'applescript', bf: 'brainfuck', sqf: 'sqf', nut: 'squirrel',
  svelte: 'svelte', astro: 'astro', ejs: 'ejs', hbs: 'handlebars', handlebars: 'handlebars', pug: 'pug',
  twig: 'twig', jinja: 'jinja', j2: 'jinja', templ: 'templ', marko: 'marko',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', prisma: 'prisma', http: 'http',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', tf: 'terraform', tfvars: 'terraform', nix: 'nix', cmake: 'cmake',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat',
};
// Files known by their name rather than their extension (matched in lower case).
const DISCORD_FILES: Record<string, string> = {
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git', '.mailmap': 'git',
  '.gitlab-ci.yml': 'gitlab', '.travis.yml': 'travis', 'appveyor.yml': 'appveyor', '.editorconfig': 'editorconfig',
  'package.json': 'npm', 'package-lock.json': 'npm', '.npmrc': 'npm', '.npmignore': 'npm', 'yarn.lock': 'yarn',
  '.yarnrc': 'yarn', '.yarnrc.yml': 'yarn', 'bower.json': 'bower', 'cargo.toml': 'cargo', 'cargo.lock': 'cargo',
  'gemfile': 'gemfile', 'gemfile.lock': 'gemfile', 'makefile': 'makefile', 'gnumakefile': 'makefile',
  'cmakelists.txt': 'cmake', 'build.bazel': 'bazel', 'workspace': 'bazel', 'procfile': 'heroku',
  'vercel.json': 'vercel', 'firebase.json': 'firebase', 'turbo.json': 'turbo', 'nodemon.json': 'nodemon',
  '.flowconfig': 'flowconfig', '.vscodeignore': 'vscodeignore', 'gulpfile.js': 'gulp', 'gruntfile.js': 'gruntfile',
  'vue.config.js': 'vueconfig',
};
// Config files whose names start the same whatever their extension (vite.config.ts, .eslintrc.json, ...).
const DISCORD_PREFIXES: [string, string][] = [
  ['vite.config.', 'viteconfig'], ['vitest.config.', 'vitestconfig'], ['astro.config.', 'astroconfig'],
  ['tailwind.config.', 'tailwind'], ['postcss.config.', 'postcss'], ['webpack.config.', 'webpack'],
  ['jest.config.', 'jest'], ['babel.config.', 'babel'], ['.babelrc', 'babel'], ['eslint.config.', 'eslint'],
  ['.eslintrc', 'eslint'], ['.eslintignore', 'eslint'], ['prettier.config.', 'prettier'], ['.prettierrc', 'prettier'],
  ['.prettierignore', 'prettier'], ['docker-compose', 'docker'], ['compose.y', 'docker'], ['build.gradle', 'gradle'],
  ['settings.gradle', 'gradle'],
];
function discordIcon(path: string): string {
  const name = baseName(path).toLowerCase();
  const byName = DISCORD_FILES[name] ?? DISCORD_PREFIXES.find(([p]) => name.startsWith(p))?.[1];
  if (byName) return byName;
  if (name.endsWith('.d.ts')) return 'typescript-def';
  const lexer = langOf(path)[0];
  if (lexer === 'docker') return 'docker';
  if (lexer === 'env') return 'env';
  return DISCORD_ICONS[extOf(path)] ?? 'text';
}
// Settings → Discord shows this state; there is no status bar button any more.
let discordState: { state: 'on' | 'off' | 'error'; why: string } = { state: 'off', why: '' };
function renderDiscord(state: 'on' | 'off' | 'error', why = ''): void {
  discordState = { state, why };
  refreshSettings();
}
async function pushDiscord(): Promise<void> {
  if (!appState.discord) return;
  try {
    await api.discord.set(discordActivity());
    if (!discordLive) renderDiscord('on');
    discordLive = true;
  } catch (e) {
    discordLive = false;
    // Said once, in a toast; Settings only shows "Not connected" until it comes back.
    if (discordState.state !== 'error') toast(errMsg(e));
    renderDiscord('error');
  }
}
function queueDiscord(): void {
  if (!appState.discord) return;
  clearTimeout(discordTimer);
  discordTimer = setTimeout(() => void pushDiscord(), 1200);
}
async function discordOn(details: boolean): Promise<boolean> {
  appState.discordDetails = details;
  try {
    const r = await api.discord.set(discordActivity());
    appState.discord = true; discordLive = true; saveApp();
    renderDiscord('on');
    toast(r.user ? `Showing on Discord as ${r.user}` : 'Discord presence on');
    return true;
  } catch (e) {
    toast(errMsg(e));
    return false;
  }
}
function discordOff(): void {
  appState.discord = false; discordLive = false; saveApp();
  clearTimeout(discordTimer);
  renderDiscord('off');
  background(api.discord.clear());
}
