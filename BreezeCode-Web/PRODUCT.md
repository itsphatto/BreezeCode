# Product

<!-- impeccable:product-schema 1 -->

Scope: the Breeze Code marketing site (`BreezeCode-Web/`), meaning the landing page, FAQ, privacy and terms. The desktop app's product record is `../PRODUCT.md`, and its users, positioning and principles apply here too.

## Platform

web

## Users

- **Primary:** new and hobby coders who are deciding whether to download Breeze Code. They may not know the terms "agent", "LLM" or "Ollama" yet.
- **Also:** working developers comparing Breeze with heavier AI editors, who look for bring-your-own-agent support, local models and a small footprint.

## Product Purpose

The site explains what Breeze Code is, shows agents working in the open, answers trust questions (cost, safety, privacy, platform), and sends people to download the Windows installer. Success means a visitor understands the product and downloads it from the official GitHub release.

## Positioning

Four pillars: work in the open (every read, edit and command shows live), bring your own agent, light and local, and fun while you wait. The app no longer has a plan → approve → build mode, so the site doesn't claim one. The site's job is to make all four believable to a beginner.

## Operating Context

- Static HTML/CSS/JS (`index.html`, `FAQ.html`, `privacy.html`, `terms.html`, `styles.css`, `site.js`, `assets/vendor/lenis.min.js` for smooth scrolling), deployed on Vercel from this folder with no build step.
- Fonts (Inter, Unbounded, Google Sans Code) and colours match the app's `src/renderer/breeze.css`.
- Downloads point to `https://github.com/itsphatto/BreezeCode/releases/latest`. The source is linked at `https://github.com/itsphatto/BreezeCode`.
- Local preview runs on `python -m http.server 5181` from `.claude/launch.json` (`breeze-web`).

## Capabilities and Constraints

- Facts the site may state: free; not marketed as open source (the repo is public and its LICENSE is MIT, but the site doesn't advertise either); Windows 10/11 64-bit only, with no Mac or Linux version yet; installer of about 110 MB; unsigned, so SmartScreen warns ("More info → Run anyway"); detects Claude Code, Codex and Antigravity; several agents can share one task through @mentions; runs local models via Ollama, LM Studio or any OpenAI-compatible server; F5 runs Python, C, C++, C#, Java (JDK 11+) and Rust (rustc, or cargo inside a Cargo project); JS runs via Node; HTML/CSS live preview; updates ask before downloading.
- Privacy: files stay on the machine. Cloud agents send task data to their provider under that provider's terms. Keys are encrypted with the Windows keychain.

## Brand Commitments

- Name: **Breeze Code**. Brand assets: `assets/brand/` (Icon, BreezeCode wordmark, Agent), plus favicons in the site root.
- Voice: plain, short, and direct, with questions answered the way the FAQ answers them.

## Evidence on Hand

- Product screenshots in `assets/screens/` (hero, agent at work, Git, setup agents, Box, Vibe), captured from the renderer's browser demo with scripted agent runs.
- Agent logos (`assets/agents/`) and language logos (`assets/langs/`).
- **The "Up to 12× less memory" line is a rough estimate.** Keep it hedged ("up to"), don't make it more specific, and don't present it as a benchmark.
- There are no testimonials, user counts, download stats, press or company logos. Don't make any up.

## Product Principles

1. **Show the real product.** Use real screenshots rather than abstract illustrations of AI.
2. **Earn trust upfront.** Free, local and the SmartScreen warning are explained plainly and early, not buried.
3. **Beginner-first language.** Explain every term or avoid it. Experts will skim past it, but beginners would bounce off it.
4. **One clear action.** Everything leads to downloading from the official GitHub release.
