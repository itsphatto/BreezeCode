# Quantified developer pain points and unmet tooling needs from major developer surveys

Research date: 2026-11-16. Data year is marked on each item. Items without a year are 2025 unless stated. "Secondary" means I could not reach the primary page and am relying on press coverage.

## 1. What are the top frustrations and time sinks in SO 2025/2026, JetBrains, State of JS/CSS/HTML, Octoverse, DORA and Atlassian?

### Takeaway
General-software surveys point to two groups of pain. The first is AI output that is almost right but costly to verify (SO 2025: 66%). The second is non-coding organizational friction: finding information, unclear priorities, inefficient processes and fragmented tools (Atlassian: 50% lose 10+ hours a week; SO 2026: unclear priorities 16.6%). The web-specific surveys point to architecture, state management and dependencies in JS, and to styling and browser-support gaps in HTML/CSS.

### Cited Findings

**Stack Overflow Developer Survey 2025 (about 49,000 responses, 177 countries; AI questions n of about 2,600 to 33,000)**
- The 2025 survey had 49,000+ responses from 177 countries, with 62 questions on 314 technologies — [Search summary of SO 2025 results](https://survey.stackoverflow.co/2025/), [SO blog](https://stackoverflow.blog/2025/07/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here)
- Top AI frustration (n=31,476): "AI solutions that are almost right, but not quite" 66%; "debugging AI-generated code is more time-consuming" 45.2%; don't use AI regularly 23.5%; less confident in own problem-solving 20%; hard to understand how or why code works 16.3%; no problems 4% — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Trust (n=33,244): highly trust 3.1%, somewhat trust 29.6%; somewhat distrust 26.1%, highly distrust 19.6% (about 46% distrust); experienced developers most skeptical at 20.7% highly distrust — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- AI on complex tasks (n=33,230): 22% rate it bad and 17.6% very poor — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- AI agent concerns (n=28,930): 87% worry about accuracy of agent output; 81% worry about data security and privacy — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Agents (n=31,877): about 31% use agents at work; 37.9% don't plan to; among agent users (n=12,823) about 70% say time on tasks fell, about 69% say productivity rose, about 37.5% say code quality improved, and about 17% say team collaboration improved (lowest) — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Why developers still ask people (n=29,163): don't trust AI answers 75.3%; ethical/security concerns 61.7%; want to fully understand 61.3%; stuck and can't explain the problem 54.6% — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Vibe coding (n=26,564): about 77% say no or emphatically no; about 15% yes in some form — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Work (n=26,622): 28.4% not happy at work, 24.5% happy, 47.1% complacent; 54% use 6+ tools at work (n=27,378). Reasons for rejecting a tool (n=34,188): security/privacy (1), prohibitive pricing (2), better alternatives (3); "inefficient or time-costly" ranks 5th of 10; lack of AI integration ranks last — [SO 2025 Work](https://survey.stackoverflow.co/2025/work)
- Tool counts (27k+ respondents): 45.5% use 1-5 tools, 35.4% use 6-10, 9.5% use 11-15, 5.1% use 16-20, 3.8% use 21+ — [SO blog retrospective, Sept 2026](https://stackoverflow.blog/2026/09/30/getting-ready-for-2026-results-a-look-back-on-developer-survey-findings/)
- Editors (all respondents): VS Code 75.9%, Visual Studio 29%, IntelliJ 27.1%, Notepad++ 27.4%, Vim 24.3%, Cursor 17.9%, Neovim 14% — [SO 2025 Technology](https://survey.stackoverflow.co/2025/technology)
- Tasks developers don't plan to give AI (SO pulse survey, 800+ devs, Oct 2025): deployments 79%, documenting code 39%, other documentation 40%. Task frustration scores (0-100): proprietary code 67 time / 44 frustration (66% frequency); maintaining reliability/performance 50 / 48 (43%); migrating to a new tool or workflow named among most frustrating (no number) — [SO blog, Dec 2025](https://stackoverflow.blog/2025/12/10/tell-us-what-you-really-really-do-not-want-to-spend-time-working-on/)

**Stack Overflow Developer Survey 2026 (published 2026-10-06; 30,903 responses, 169 countries)**
- Sample and headline: 30,903 responses, 169 countries, 467 technologies, 103 questions — [SO 2026 survey site](https://survey.stackoverflow.co/2026/); [SO blog](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
- Frustrations at work (what made the job harder in the past 6 months, n=18,214): unclear priorities or requirements 16.6%; inefficient processes/workflows/coordination 14.6%; not enough time/staffing/resources 14.1%; leadership or org changes 11.9%; unreliable systems/infrastructure/environments 8.4%; poor documentation or knowledge sharing 7.1%; nothing made it harder 9.6% — [SO 2026 Work](https://survey.stackoverflow.co/2026/work)
- What helped (same survey): nothing 21.1%; right tools or platforms 20.1%; supportive teammates/managers 17.2%; clear priorities 7.1% — [SO 2026 Work](https://survey.stackoverflow.co/2026/work)
- Job satisfaction (n=18,876): 33% not happy, 45% complacent ("just settling"), 22% happy; unhappy up 4 points and happy down 2 points vs 2025. Freelance/self-employed rose from 3.9% to 10.5% — [SO 2026 survey site](https://survey.stackoverflow.co/2026/), [SO 2026 Work](https://survey.stackoverflow.co/2026/work)
- Context/knowledge problems (SO 2026): 63% cite incomplete information (7,825), 61% say important context lives in people's heads, 56% say information is outdated, 53% say it is spread across too many tools, 31% don't know where to look, 79% find important context only after starting or finishing a task. A headline "75% spend five or more hours searching for answers" has no supporting table on the page, so treat it as unverified — [SO 2026 survey site](https://survey.stackoverflow.co/2026/)
- AI in 2026: 66% use coding assistants/agents; 73% of those use them daily (SO blog); trust is conditional, with 48% trusting AI only when they can validate it and 93% saying source attribution is needed. Where AI is used: familiar-area code 67%, debugging/refactoring 61%, deploy/operate/troubleshoot production only 20% — [SO blog 2026](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/), [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- Reasons to avoid AI in 2026 (n=13,857; among the 59% who avoid it in some way): losing job skills 17%, moral/ethical 15%, privacy/security 13%, environmental 8%. 41% don't avoid AI — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- Where answers come from: online search 83%, AI agent 70%, coworkers 72% for work questions, code and comments 63%, internal docs 60% — [SO blog 2026](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
- Editors in 2026: VS Code still leads; Visual Studio third behind Notepad++; Claude Code leads AI coding agents at 66% ahead of GitHub Copilot at 59% — [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2026/10/06/stack-overflow-2026-survey-vs-code-leads-visual-studio-takes-third.aspx), [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)

**JetBrains State of Developer Ecosystem 2025 (24,534 developers after cleaning, April-June 2025, weighted; JetBrains-user bias acknowledged)**
- 85% use AI coding tools; 68% expect AI proficiency to become a job requirement; developers saving 8+ hours/week rose from 9% (2024) to 19% (2025); 23% worry about low-quality generated code — [The Register](https://www.theregister.com/2025/10/21/massive_jetbrains_dev_survey)
- Top five AI concerns per secondary coverage: inconsistent code quality 23%, limited understanding of complex code/logic 18%, privacy and security 13%, negative effect on skills 11%, lack of context awareness 10%. Primary JetBrains page was blocked (403) and the dataviz page did not show the numbers, so treat these as unverified secondary figures — [Search results summary](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/), [JetBrains AI page](https://devecosystem-2025.jetbrains.com/artificial-intelligence)
- JetBrains Developer Experience report (2025 survey, developers N=6,144, tech managers N=2,360): 89% of developers say non-technical factors (processes, communication, goals, well-being) influence productivity moderately or significantly (62% significantly); 84% say the same for technical factors (51% significantly) — [JetBrains DevEx report](https://lp.jetbrains.com/devex-productivity-report-full-2025-dataviz/)
- Same report: 33% of developers say satisfaction with development tools is not measured at all and 16% don't know (49% combined, N=6,009); 36% don't believe their productivity metrics reflect their contribution and 30% are unsure (N=4,240) — [JetBrains DevEx report](https://lp.jetbrains.com/devex-productivity-report-full-2025-dataviz/)
- Reasons tech managers unhappy with DevEx give (2024 data, N=146, so older): productivity/DevEx not a company priority 27%; inefficient processes and policies 24%; poor leadership/communication 20%; no proper metrics 14%; culture/structure 14%; lack of tool budget 14% — [JetBrains DevEx report](https://lp.jetbrains.com/devex-productivity-report-full-2025-dataviz/)
- Kent Beck quote in coverage: developers spend "most of our time on a task the IDE barely acknowledges exists," suggesting IDEs may not fit agentic coding — [The Register](https://www.theregister.com/2025/10/21/massive_jetbrains_dev_survey)

**Atlassian State of DevEx 2025 (3,500 developers and managers, six countries)**
- 50% lose 10+ hours a week to non-coding friction (33% in the prior year's report); 90% lose 6+ hours; 68% save 10+ hours/week with AI (99% report saving some time); developers spend 16% of their time coding; organizations with 500 developers could lose up to $7.9M a year — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025), [LeadDev](https://leaddev.com/velocity/ai-productivity-gains-are-being-offset-by-organizational-bottlenecks)
- Top time-wasters per Atlassian's blog: finding information (services, docs, APIs), adapting to new technology, context switching between tools; tech debt dropped out of the top five and cross-team collaboration moved up. No percentages given — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025)
- 63% say leaders don't understand developers' pain points, up from 44% a year earlier; developers who self-serve documentation and knowledge are 4.4x more productive — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025), [LeadDev](https://leaddev.com/velocity/ai-productivity-gains-are-being-offset-by-organizational-bottlenecks)

**DORA 2025 State of AI-assisted Software Development (nearly 5,000 respondents)**
- 90% use AI (up 14% from 2024); 65% rely on it heavily per the Google blog's categories; 24% trust it "a lot" or "a great deal" and 30% trust it "a little" or "not at all"; median 2 hours/day with AI; over 80% report improved productivity; 59% report positive code-quality effect — [Google blog on DORA 2025](https://blog.google/technology/developers/dora-report-2025/)
- Framing: AI is an "amplifier" of existing organizational strengths and weaknesses; platform teams are more important; seven-capability AI Capabilities Model — [Search summary of DORA 2025](https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf)
- I could not read the DORA PDF (over the 10MB fetch limit), so friction, burnout and instability figures are not captured.

**State of JS 2025 (JavaScript pain points question, 10,038 respondents; shares are my calculation = count / 10,038)**
- Code architecture 37.6% (3,777); state management 34.5%; managing dependencies 31.6%; date management 26.4%; performance 25.4%; build tools 22.7%; debugging 21.5%; typing 18.9%; finding packages 12.8%; async code 11.0%. Five more options are hidden behind "Show All" and not captured — [State of JS 2025 usage](https://2025.stateofjs.com/en-US/usage/)

**State of CSS**
- 2025 "other CSS pain points" (419 respondents, about 8% of all respondents): browser support 41 (about 10%), speed of change 16, excessive complexity 15, Safari 14, excessive Tailwind usage 13, hard-to-remember syntax 12, debugging 12, conditional logic 11, layout and positioning 10 — [State of CSS 2025 usage](https://2025.stateofcss.com/en-US/usage/)
- The 2026 State of CSS pain-points page (appears to be live; counts but no total; may be partial or in-progress data): layout 632 (13%), colors 573 (12%), interactions 429 (9%), general 398 (8%), shapes/graphics 355 (7%), other features 231 (5%) — [State of CSS 2026 pain points](https://2026.stateofcss.com/en-US/pain-points/)
- Coverage notes calc() unit handling, animation to auto, and missing random() as repeated complaints — [Search summary of State of CSS 2025](https://2025.stateofcss.com/en-US/features/)

**State of HTML 2025**
- Hardest elements to style (3,331 respondents, 54%): `<select>` 1,699; `<input type=date>` 1,178; `<select multiple>` 792; checkbox 791; validation errors 491 — [State of HTML 2025 usage](https://2025.stateofhtml.com/en-US/usage/)
- Interoperability limits (884, 14%): popover 163, select 108, anchor positioning 92, customizable select 76, web components 63, dialog 60 — [State of HTML 2025 usage](https://2025.stateofhtml.com/en-US/usage/)
- Browser support stands out as a pain, especially in the Apple ecosystem — [State of HTML 2025 usage](https://2025.stateofhtml.com/en-US/usage/)

**GitHub Octoverse 2025**
- Octoverse is platform activity data, not a pain-point survey. TypeScript became #1 by monthly contributors in Aug 2025 (2,636,006, +66.6% YoY), attributed to framework defaults and AI-assisted development; GitHub's view is that skill is shifting toward verifying, designing and debugging AI-generated code — [Visual Studio Magazine](https://visualstudiomagazine.com/Articles/2025/10/31/TypeScript-Tops-GitHub-Octoverse-as-AI-Era-Reshapes-Language-Choices.aspx), [GitHub blog](https://github.blog/2025-12-09-why-ai-is-pushing-developers-toward-typed-languages/)

### Inferences
- The largest quantified pain clusters are (a) AI output verification (SO 2025: 66%/45%; JetBrains 23% and 18%), (b) information finding and context (Atlassian, SO 2026 context stats), and (c) unclear priorities and process (SO 2026 16.6% and 14.6%).
- A tool-shaped reading: tools that surface requirements, decisions and docs inside the editor, and tools that help review AI-generated diffs, address stated pains. This is my inference, not a respondent request.
- Tool sprawl is real but moderate: about 54% use 6+ tools at work (SO 2025).

### Gaps
- DORA 2025 friction, burnout and instability numbers: PDF too large to fetch.
- JetBrains 2025 concern percentages: primary page blocked; only secondary figures.
- State of JS 2025 respondent count and the hidden pain-point options: not retrieved.
- State of CSS 2025 total respondents and the 2026 page's publication status: unclear.
- Octoverse has no developer-pain survey data.

## 2. Which specific missing features or tool categories do respondents name?

### Takeaway
The surveys mostly give closed-category data, and little free-text "missing feature" data was retrievable. The clearest named gaps are in HTML (native data table, combobox, tabs, dropdown menu, rich text editor), styling form controls, and AI agent memory/orchestration; in IDE terms, JetBrains' quote says agentic work is poorly served.

### Cited Findings
- Most-wanted new HTML elements (3,887 respondents, 62%; shares my calculation): data table 1,545 (about 40%); combobox/autocomplete 1,249 (about 32%); tabs 1,182 (about 30%); dropdown menu 1,071 (about 28%); rich text editor 975 (about 25%); switch/toggle 957; HTML include 920; sortable drag-and-drop list 910; skeleton UI 728; context menu 719 — [State of HTML 2025 usage](https://2025.stateofhtml.com/en-US/usage/)
- SO 2026 AI page: AI memory and agent orchestration tools show a gap between current adoption and stated interest (no numbers); LangChain 30% and OpenAI Agents SDK 24% lead orchestration — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- SO 2025: tool "inefficient or time-costly" is a rejection reason (rank 5 of 10); lack of AI is the least-cited detractor, so developers are not asking for more AI in every tool — [SO 2025 Work](https://survey.stackoverflow.co/2025/work)
- JetBrains: 49% of developers report that tool satisfaction isn't measured or they don't know — an unmet measurement need — [JetBrains DevEx report](https://lp.jetbrains.com/devex-productivity-report-full-2025-dataviz/)
- Atlassian: finding information across services/docs/APIs is the top time-waster; self-serve documentation access corresponds to 4.4x productivity — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025), [LeadDev](https://leaddev.com/velocity/ai-productivity-gains-are-being-offset-by-organizational-bottlenecks)
- SO 2026 most-needed AI context: project goals/requirements 85%, code and docs 73%, prior decisions 44% — [SO blog 2026](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)

### Inferences
- Gaps implied by the data: requirement/decision context that travels with the code, verification aids for AI output, docs and information retrieval, and styling/debugging help for form controls and CSS.

### Gaps
- No open-ended "missing feature" responses for editors/IDEs were found in any of the surveys fetched.
- State of JS "missing feature" free text and State of CSS 2025 feature wish-lists were not retrieved.

## 3. Which pain points are niche (not served by mainstream IDEs/editors) yet affect a large share of developers?

### Takeaway
The best candidates are non-code context (requirements, decisions, docs) and verification of AI output, plus CSS/form-control styling and cross-browser support for web developers. Each affects tens of percent of respondents, and none is a core mainstream-IDE feature.

### Cited Findings
- Context scattered or missing: 63% incomplete information, 61% in people's heads, 56% outdated, 53% too many tools (SO 2026) — [SO 2026 survey site](https://survey.stackoverflow.co/2026/)
- Time loss unrelated to typing code: 50% lose 10+ hours a week; coding is 16% of time (Atlassian 2025) — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025)
- AI verification: 66% and 45.2% (SO 2025); 48% trust only if easily validated (SO 2026) — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai), [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- Web styling: 54% of State of HTML respondents name hard-to-style elements, led by `<select>` at 1,699 of 3,331 — [State of HTML 2025 usage](https://2025.stateofhtml.com/en-US/usage/)
- JS architecture and state management: 37.6% and 34.5% of 10,038 — [State of JS 2025 usage](https://2025.stateofjs.com/en-US/usage/)
- Browser support: about 10% in State of CSS 2025 (low share, described as reduced by recent improvements); 14% of State of HTML respondents cite browser interoperability limits — [State of CSS 2025 usage](https://2025.stateofcss.com/en-US/usage/), [State of HTML 2025 usage](https://2025.stateofhtml.com/en-US/usage/)
- Mainstream editor market is concentrated (VS Code 75.9%), so these gaps sit in the dominant editor's extension space or outside editors — [SO 2025 Technology](https://survey.stackoverflow.co/2025/technology)

### Inferences
- Several of these (priorities, leadership, processes) are organizational and not solvable by an editor; the tool-addressable subset is context retrieval, AI-diff review and CSS/form debugging. This classification is mine.

### Gaps
- No survey measures "unserved by IDEs" directly; the classification is inferred.

## 4. Where do surveys disagree?

### Takeaway
They differ mostly on AI trust and whether AI helps, on what the top time-wasters are, and on how big browser support is as a web pain.

### Cited Findings
- AI trust: SO 2025 says about 33% trust and about 46% distrust AI accuracy; SO 2026 says 87%+ trust to some degree, but a Korean analysis warns the question wording changed, so the figures aren't comparable. DORA 2025 reports 24% high trust ("a lot" or "a great deal") and 30% low trust — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai), [SO 2026 survey site](https://survey.stackoverflow.co/2026/), [Google DORA blog](https://blog.google/technology/developers/dora-report-2025/)
- AI productivity: DORA over 80% say productivity improved; Atlassian 99% save time, 68% save over 10 hours; LeadDev (617 leaders, Mar 2025) only 6% report a significant boost and 39% minor gains of 1-10%; SO 2025 agent users about 69% report higher productivity but only about 37.5% report better code quality — [Google DORA blog](https://blog.google/technology/developers/dora-report-2025/), [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025), [LeadDev](https://leaddev.com/velocity/ai-productivity-gains-are-being-offset-by-organizational-bottlenecks), [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Time-waster ranking within Atlassian 2025: the Atlassian blog lists finding information, adapting to new technology and context switching, while LeadDev's summary lists finding information, lack of clear leadership direction and poor team collaboration. The Atlassian blog adds that tech debt dropped out of the top five — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025), [LeadDev](https://leaddev.com/velocity/ai-productivity-gains-are-being-offset-by-organizational-bottlenecks)
- Whether tool quality or organization matters more: JetBrains says non-technical factors influence productivity (89%) slightly more than technical (84%), while SO 2025 tool rejection is about security, price and alternatives rather than process — [JetBrains DevEx report](https://lp.jetbrains.com/devex-productivity-report-full-2025-dataviz/), [SO 2025 Work](https://survey.stackoverflow.co/2025/work)
- Agent adoption: 31% in SO 2025 vs 59% in an April 2026 SO pulse (per SO retrospective, no n); JetBrains reports 85% use AI tools and DORA 90%, which are broader definitions than SO's agent question — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai), [SO blog retrospective](https://stackoverflow.blog/2026/09/30/getting-ready-for-2026-results-a-look-back-on-developer-survey-findings/)
- Sampling bias: JetBrains notes its own users respond more often and weights data; its survey shows higher JetBrains IDE/Java/Kotlin share than SO. SO samples are self-selected from SO channels — [The Register](https://www.theregister.com/2025/10/21/massive_jetbrains_dev_survey)
- SO's own figures vary slightly between pages (e.g., 20% vs 20.7% for experienced developers' distrust) — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Atlassian and JetBrains are vendor-run surveys with a commercial interest in DevEx tooling; I did not verify their methodology.

### Inferences
- Percentages across surveys are not comparable without checking question wording, base (all respondents vs question respondents) and year.

### Gaps
- No direct reconciliation of SO 2025 vs 2026 AI trust beyond the wording-change caveat.
- 2026 data from JetBrains, State of JS 2026, DORA 2026 and Atlassian 2026 were not found in this pass; State of CSS 2026 pain-point counts appeared but publication status is unclear.
