"use strict";
/* ================= Agents (UI) ================= */
// No agent cards show until a task is under way. Once the agent answers, the panel says how many
// agents the task needs, and each card appears when that agent starts working.
let team = [];
let teamNeed = 0; // how many agents the current task needs
const TEAM_SIZE = { ask: 1, build: 1, plan: 2 };
const TEAM_LINE = {
    ask: '1 agent on this: <b>Assistant</b> answers without changing files',
    build: '1 agent on this: <b>Builder</b> makes the changes',
    plan: '2 agents on this: <b>Planner</b> writes a plan, then <b>Builder</b> builds it once you approve',
};
// The agent doing the work: the one a run was given to (@Claude in a chat whose default is Codex), else the default.
function responder(agentId) {
    if (!agentId)
        return selectedAgent();
    return appState.detect?.agents.find(a => a.id === agentId && a.found) ?? selectedAgent();
}
// Planner, Builder and Assistant wear the logo and name of the agent doing the work (Codex, Claude Code…).
function roleMark(k, agentId) {
    const chosen = responder(agentId);
    if (!chosen)
        return { letter: agentsDef[k].letter, tint: agentsDef[k].tint };
    return AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: chosen.id };
}
function teamLineHtml(mode, agentId) {
    const chosen = responder(agentId);
    const agentName = chosen?.name ?? 'Assistant';
    if (mode === 'ask') {
        return `1 agent on this: <b>${esc(agentName)}</b> answers without changing files`;
    }
    if (mode === 'build' && chosen) {
        return `1 agent on this: <b>${esc(agentName)}</b> makes the changes`;
    }
    return TEAM_LINE[mode] ?? '';
}
function renderAgents() {
    const cards = $('#agentCards');
    const shown = new Set($$('[data-agent-card]', cards).map(el => el.dataset.agentCard));
    cards.classList.toggle('hidden', !team.length);
    cards.innerHTML = team.map(k => {
        const a = agentsDef[k];
        const m = roleMark(k, a.agentId);
        const who = a.agentId ? responder(a.agentId) : null;
        return `<div class="agent ${a.status}${shown.has(k) ? '' : ' enter'}" data-agent-card="${k}">
      ${brandMark('ava', m.tint, m.letter)}
      <div><span class="name">${esc(who?.name ?? a.name)}</span> <span class="fs-11 text-3">${esc(who ? modelLabel(who) : a.model)}</span></div>
      <div class="row gap-4"><span class="status ${a.status}">${statusLabel[a.status]}</span>
        ${a.status === 'working' ? `<button class="icon-btn" title="Stop" data-act="agent.stop">${svgIcon('stop')}</button>` : ''}</div>
      <div class="task">${esc(a.task)}</div>
      <div class="meter" title="${a.used} tool calls"><i class="tint-${a.tint}" data-used="${a.used}"></i></div>
    </div>`;
    }).join('');
    // The meter's fill is set through the DOM: the CSP allows no inline style attributes.
    for (const i of $$('[data-used]', cards))
        i.style.width = `${Math.min(100, Number(i.dataset.used) * 4)}%`;
    const count = $('#agentCount');
    const n = Math.max(teamNeed, team.length);
    count.textContent = String(n);
    count.title = `${plural(n, 'agent')} on this task`;
    count.classList.toggle('hidden', !n);
}
function joinTeam(k) {
    if (team.includes(k))
        return;
    team.push(k);
    renderAgents();
}
function resetTeam() {
    team = [];
    teamNeed = 0;
    setAgent('assistant', 'idle', 'Waiting for a question', 0);
    setAgent('planner', 'idle', 'Waiting for a prompt', 0);
    setAgent('builder', 'idle', 'Waiting for a plan', 0);
    for (const a of Object.values(agentsDef))
        a.agentId = undefined;
}
function setAgent(k, status, task, used) {
    Object.assign(agentsDef[k], { status, task });
    if (used != null)
        agentsDef[k].used = used;
    renderAgents();
    vibeTick();
    queueDiscord();
    const curTab = surfaceTabs[surface.name]?.find(t => t.id === activeTabId[surface.name]);
    if (status === 'working' && curTab?.run?.phase === k)
        showThinking(thinkingLabel(k, curTab.run.agent), k, curTab, curTab.run.agent);
}
const attachmentsMap = { ide: [], box: [] };
const SURFACES = {
    ide: { name: 'ide', chat: $('#chat'), prompt: $('#prompt'), send: $('#send'), mode: $('#agentMode'), attachmentsEl: $('#promptAttachments') },
    box: { name: 'box', chat: $('#boxChat'), prompt: $('#boxPrompt'), send: $('#boxSend'), mode: $('#boxMode'), attachmentsEl: $('#boxPromptAttachments') },
};
let surface = SURFACES.ide; // the one on screen
let msgSurface = surface; // fallback surface
let agentRun = null;
// The team member whose event is being handled; addMsg gives its lines its logo and name. Null outside team tabs.
let labelAgent = null;
let lastRunFiles = [];
// The tab (and run) a run id belongs to: a tab's own single run, or one member of its agent team.
function findTabForRun(runId) {
    for (const sName of ['ide', 'box']) {
        for (const tab of surfaceTabs[sName]) {
            const run = tab.runId === runId ? tab.run : tab.agentTeam?.runs.get(runId);
            if (run)
                return { tab, run };
        }
    }
    return null;
}
const surfaceTabs = { ide: [], box: [] };
const activeTabId = { ide: '', box: '' };
const createdTabIds = new Set();
// A tab is busy while a run, a team's claim pass (runId -1) or any member of its team is still going.
function tabBusy(t) {
    return t.runId != null || (t.agentTeam?.pending ?? 0) > 0;
}
function hasAnyActiveRun() {
    for (const list of Object.values(surfaceTabs)) {
        if (list.some(tabBusy))
            return true;
    }
    return false;
}
function refreshTabBusy(tab) {
    const s = SURFACES[tab.surfaceName];
    if (tab.id === activeTabId[tab.surfaceName])
        updateTabBusyState(s, tab);
    renderAgentTabs(s);
}
function getActiveTab(s = surface) {
    const list = surfaceTabs[s.name];
    if (!list.length) {
        const initial = createAgentTab(s);
        activeTabId[s.name] = initial.id;
        initial.panel.classList.add('active');
        renderAgentTabs(s);
        return initial;
    }
    let tab = list.find(t => t.id === activeTabId[s.name]);
    if (!tab) {
        tab = list[0];
        activeTabId[s.name] = tab.id;
        tab.panel.classList.add('active');
        renderAgentTabs(s);
    }
    return tab;
}
function createAgentTab(s, title, initialHtml, session, markNew = false) {
    const count = surfaceTabs[s.name].length + 1;
    const tab = {
        id: 'atab_' + crypto.randomUUID().slice(0, 8),
        surfaceName: s.name,
        title: title || `Chat ${count}`,
        panel: document.createElement('div'),
        runId: null,
        run: null,
        sessions: session && appState.agent ? { [appState.agent]: session } : {},
        agentId: appState.agent || 'antigravity',
        uiMode: 'build',
        promptDraft: '',
        attachments: [],
    };
    tab.panel.className = 'agent-tab-panel';
    if (initialHtml) {
        setSavedHtml(tab.panel, initialHtml);
    }
    else if (s.name === 'box') {
        tab.panel.innerHTML = boxEmptyHtml();
    }
    else {
        tab.panel.innerHTML = `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div class="empty-line">Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
    }
    s.chat.appendChild(tab.panel);
    surfaceTabs[s.name].push(tab);
    if (markNew)
        createdTabIds.add(tab.id);
    renderAgentTabs(s);
    return tab;
}
const agentInkAt = { ide: null, box: null };
function placeAgentTabInk(s) {
    const tabsList = s.name === 'box' ? $('#boxAgentTabsList') : $('#agentTabsList');
    if (!tabsList)
        return;
    const on = tabsList.querySelector('.agent-tab.active:not(.leaving)');
    const old = tabsList.querySelector('.agent-tab-ink');
    if (!on) {
        if (old) {
            old.style.opacity = '0';
            setTimeout(() => old.remove(), 120);
        }
        agentInkAt[s.name] = null;
        return;
    }
    const ink = old ?? tabsList.appendChild(Object.assign(document.createElement('span'), { className: 'agent-tab-ink' }));
    ink.style.opacity = '1';
    const next = {
        x: on.offsetLeft + 8,
        y: on.offsetTop + on.offsetHeight - 2,
        w: Math.max(0, on.offsetWidth - 16)
    };
    const draw = (p) => {
        ink.style.transform = `translate(${p.x}px, ${p.y}px)`;
        ink.style.width = `${p.w}px`;
    };
    if (agentInkAt[s.name]) {
        ink.style.transition = 'none';
        draw(agentInkAt[s.name]);
        const _reflow = ink.offsetWidth;
        ink.style.transition = '';
    }
    draw(next);
    agentInkAt[s.name] = next;
}
const closingAgentTabs = new Set();
function renderAgentTabs(s) {
    const tabsList = s.name === 'box' ? $('#boxAgentTabsList') : $('#agentTabsList');
    if (!tabsList)
        return;
    const list = surfaceTabs[s.name];
    const curId = activeTabId[s.name];
    // A tab that is folding away doesn't count, so the one that stays loses its X right as the other starts to go.
    const isMulti = list.filter(t => !closingAgentTabs.has(t.id)).length > 1;
    const currentTabIds = new Set(list.map(t => t.id));
    tabsList.querySelectorAll('.agent-tab').forEach(el => {
        const tid = el.dataset.agentTab;
        if (tid && !currentTabIds.has(tid) && !el.classList.contains('leaving')) {
            el.remove();
        }
    });
    list.forEach(t => {
        const isActive = t.id === curId;
        const isRunning = tabBusy(t);
        let el = tabsList.querySelector(`[data-agent-tab="${t.id}"]`);
        if (!el) {
            const newEl = document.createElement('div');
            newEl.dataset.agentTab = t.id;
            newEl.className = `agent-tab ${isActive ? 'active' : ''} ${isRunning ? 'running' : 'idle'} ${isMulti ? 'closable' : 'single'}`;
            newEl.innerHTML = `
        <span class="tab-status" aria-hidden="true"></span>
        <span class="tab-title">${esc(t.title)}</span>
        <button class="tab-close" type="button" data-close-tab="${escAttr(t.id)}" title="Close tab" aria-label="Close tab">
          <svg class="tab-close-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      `;
            if (createdTabIds.has(t.id)) {
                newEl.classList.add('enter');
                newEl.addEventListener('animationend', () => {
                    newEl.classList.remove('enter');
                    placeAgentTabInk(s);
                }, { once: true });
                createdTabIds.delete(t.id);
            }
            newEl.onclick = (e) => {
                const target = e.target;
                if (target.closest('[data-close-tab]') || newEl.classList.contains('leaving'))
                    return;
                switchAgentTab(s, t.id);
            };
            const closeBtn = newEl.querySelector('[data-close-tab]');
            if (closeBtn) {
                closeBtn.onclick = (e) => {
                    e.stopPropagation();
                    closeAgentTab(s, t.id);
                };
            }
            tabsList.appendChild(newEl);
        }
        else {
            el.classList.toggle('active', isActive);
            el.classList.toggle('running', isRunning);
            el.classList.toggle('idle', !isRunning);
            el.classList.remove('unread');
            el.classList.toggle('closable', isMulti);
            el.classList.toggle('single', !isMulti);
            el.removeAttribute('title');
            const titleSpan = el.querySelector('.tab-title');
            if (titleSpan && titleSpan.textContent !== t.title) {
                titleSpan.textContent = t.title;
            }
            const statusSpan = el.querySelector('.tab-status');
            if (statusSpan) {
                statusSpan.title = isRunning ? 'Working' : '';
            }
            tabsList.appendChild(el);
        }
    });
    placeAgentTabInk(s);
    // Box shows its chats in a side bar (history.ts, which loads after this file) rather than in the tab bar.
    if (s.name === 'box' && typeof renderBoxSide === 'function')
        renderBoxSide();
}
function switchAgentTab(s, tid) {
    const current = getActiveTab(s);
    if (current && current.id !== tid) {
        current.promptDraft = s.prompt.value;
        current.uiMode = s.mode.value;
        current.attachments = [...(attachmentsMap[s.name] || [])];
        current.panel.classList.remove('active');
        if (s.name === 'box' && typeof liveEmpty === 'function')
            liveEmpty(); // that chat's file isn't this one's
    }
    const next = surfaceTabs[s.name].find(t => t.id === tid);
    if (!next)
        return;
    activeTabId[s.name] = next.id;
    next.unreadDone = false;
    next.panel.classList.add('active');
    if (s.name === 'ide' && next.agentId && appState.agent !== next.agentId) {
        appState.agent = next.agentId;
        saveApp();
        renderAgentBar();
    }
    s.prompt.value = next.promptDraft || '';
    mentionWarning(s);
    s.mode.value = 'build';
    attachmentsMap[s.name] = next.attachments || [];
    renderAttachments(s);
    updateTabBusyState(s, next);
    renderAgentTabs(s);
    scrollChat(s);
    s.prompt.focus();
    updateScmGenBtn();
}
function closeAgentTab(s, tid) {
    const idx = surfaceTabs[s.name].findIndex(t => t.id === tid);
    if (idx === -1)
        return;
    const tab = surfaceTabs[s.name][idx];
    archiveChatTab(s, tab);
    if (tabBusy(tab))
        stopAgent(tab);
    else if (tab.agentTeam || tab.lastTeamId)
        dropAgentTeam(tab); // its snapshots go with it
    const tabsList = s.name === 'box' ? $('#boxAgentTabsList') : $('#agentTabsList');
    const tabEl = tabsList?.querySelector(`[data-agent-tab="${tid}"]`);
    const finalize = () => {
        closingAgentTabs.delete(tid);
        tab.panel.remove();
        const curIdx = surfaceTabs[s.name].findIndex(t => t.id === tid);
        if (curIdx !== -1)
            surfaceTabs[s.name].splice(curIdx, 1);
        tabEl?.remove();
        if (surfaceTabs[s.name].length === 0) {
            const newTab = createAgentTab(s);
            activeTabId[s.name] = newTab.id;
            newTab.panel.classList.add('active');
            updateTabBusyState(s, newTab);
        }
        else if (activeTabId[s.name] === tid) {
            const nextIdx = Math.min(idx, surfaceTabs[s.name].length - 1);
            const nextTab = surfaceTabs[s.name][nextIdx];
            activeTabId[s.name] = nextTab.id;
            nextTab.panel.classList.add('active');
            updateTabBusyState(s, nextTab);
        }
        renderAgentTabs(s);
    };
    if (tabEl && !tabEl.classList.contains('leaving')) {
        if (activeTabId[s.name] === tid && surfaceTabs[s.name].length > 1) {
            const nextIdx = idx === surfaceTabs[s.name].length - 1 ? idx - 1 : idx + 1;
            const nextTab = surfaceTabs[s.name][nextIdx];
            if (nextTab) {
                activeTabId[s.name] = nextTab.id;
                nextTab.unreadDone = false;
                tab.panel.classList.remove('active');
                nextTab.panel.classList.add('active');
                s.prompt.value = nextTab.promptDraft || '';
                mentionWarning(s);
                s.mode.value = 'build';
                attachmentsMap[s.name] = nextTab.attachments || [];
                renderAttachments(s);
                updateTabBusyState(s, nextTab);
            }
        }
        const w = tabEl.getBoundingClientRect().width;
        tabEl.style.width = `${w}px`;
        tabEl.style.maxWidth = `${w}px`;
        const _reflow = tabEl.offsetWidth;
        tabEl.classList.add('leaving');
        closingAgentTabs.add(tid);
        if (surfaceTabs[s.name].length === 2) {
            const remainingTab = surfaceTabs[s.name].find(t => t.id !== tid);
            if (remainingTab) {
                const remainingEl = tabsList?.querySelector(`[data-agent-tab="${remainingTab.id}"]`);
                if (remainingEl) {
                    remainingEl.classList.remove('closable');
                    remainingEl.classList.add('single');
                }
            }
        }
        renderAgentTabs(s);
        let finished = false;
        const onEnd = () => {
            if (finished)
                return;
            finished = true;
            finalize();
        };
        tabEl.addEventListener('transitionend', onEnd, { once: true });
        setTimeout(onEnd, 220);
    }
    else {
        finalize();
    }
}
function updateTabBusyState(s, tab) {
    const t = tab || getActiveTab(s);
    const on = tabBusy(t);
    s.send.classList.toggle('stop', on);
    void setIcon(s.send, on ? 'stop' : 'send');
    const span = $('span', s.send);
    if (span)
        swapText(span, on ? 'Stop' : 'Send');
    s.send.title = on ? 'Stop the agent' : 'Send (Enter)';
    s.prompt.closest('.composer-box')?.classList.toggle('busy', on);
}
function setBusy(on) {
    updateTabBusyState(surface);
}
function newAgentTabAction(s = surface) {
    const cur = getActiveTab(s);
    if (cur)
        archiveChatTab(s, cur);
    const newTab = createAgentTab(s, undefined, undefined, null, true);
    switchAgentTab(s, newTab.id);
    const bar = s.name === 'box' ? $('#boxAgentTabsBar') : $('#agentTabsBar');
    bar?.scrollTo({ left: bar.scrollWidth, behavior: 'smooth' });
}
function useSurface(name) {
    surface = SURFACES[name];
    msgSurface = surface;
}
function scrollChat(s) {
    const scroller = s.name === 'box' ? $('.box-main') : s.chat;
    if (scroller)
        scroller.scrollTop = scroller.scrollHeight;
}
function addMsg(html, tab) {
    const t = tab || getActiveTab(msgSurface);
    const d = document.createElement('div');
    d.innerHTML = html;
    const el = d.firstElementChild;
    if (labelAgent) {
        el.dataset.agent = labelAgent;
        // A tool line's first child is its icon, so the badge goes in front of it instead.
        const head = el.classList.contains('tool-line') ? el : el.firstElementChild ?? el;
        head.insertAdjacentHTML('afterbegin', agentBadge(labelAgent));
    }
    const thinking = t.panel.querySelector('.thinking');
    if (thinking) {
        t.panel.insertBefore(el, thinking);
    }
    else {
        t.panel.appendChild(el);
    }
    if (t.id === activeTabId[t.surfaceName]) {
        scrollChat(SURFACES[t.surfaceName]);
    }
    saveChat(t);
    return el;
}
const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// Whoever answers signs the message with their own name and logo, whichever role (Assistant, Planner, Builder) they hold.
function speaker(k, agentId) {
    const chosen = responder(agentId);
    if (chosen) {
        const st = AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: chosen.id };
        return { name: chosen.name, ...st };
    }
    return { name: agentsDef[k].name, ...roleMark(k) };
}
function agentMsg(k, html, tab, agentId) {
    const t = tab || getActiveTab(msgSurface);
    const { name, letter, tint } = speaker(k, agentId);
    sfx.play('answer');
    // In a team the agent's badge (added by addMsg) names the speaker instead.
    const who = labelAgent ? '' : `${brandMark('avatar mini', tint, letter)}<b>${esc(name)}</b> `;
    return addMsg(`<div class="msg"><div class="meta">${who}${clockTime()}</div><div class="body">${html}</div></div>`, t);
}
function userMsg(text, attachments, tab) {
    const t = tab || getActiveTab(msgSurface);
    let imgHtml = '';
    if (attachments?.length) {
        const items = attachments.map(a => {
            const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
            const p = a.path || a.fileRel || a.name;
            if (kind === 'folder') {
                return `<div class="chat-file-chip folder" data-path="${escAttr(p)}" title="Folder: ${escAttr(p)} (click to reveal)"><span class="ico">${folderIcon(a.name, false)}</span><span class="nm">${esc(p)}</span></div>`;
            }
            if (kind === 'file') {
                return `<div class="chat-file-chip file" data-path="${escAttr(p)}" title="File: ${escAttr(p)} (click to open)"><span class="ico">${fileIcon(a.name)}</span><span class="nm">${esc(p)}</span></div>`;
            }
            const src = a.fileUrl || a.dataUrl || '';
            return `<div class="chat-img-wrap" title="Click to view full size"><img src="${escAttr(src)}" class="chat-img" alt="${escAttr(a.name)}" data-full="${escAttr(src)}"></div>`;
        }).join('');
        imgHtml = `<div class="msg-attachments">${items}</div>`;
    }
    const bodyText = text ? `<div>${mentionHtml(text, msgSurface.name === 'ide').replaceAll('\n', '<br>')}</div>` : '';
    addMsg(`<div class="msg user"><div class="meta"><b>${esc(user?.name ?? 'You')}</b> ${clockTime()}</div><div class="body">${bodyText}${imgHtml}</div></div>`, t);
}
function thinkingLabel(k, agentId) {
    const who = speaker(k, agentId).name;
    const task = agentsDef[k].task;
    return msgSurface.name === 'box' || !task ? `${who} is thinking` : `${who} · ${task}`;
}
function showThinking(label, k = 'assistant', tab, agentId) {
    const t = tab || getActiveTab(msgSurface);
    let el = t.panel.querySelector('.thinking');
    if (!el) {
        el = document.createElement('div');
        el.className = 'thinking';
        el.setAttribute('role', 'status');
        el.innerHTML = '<span class="avatar mini"></span><span class="lbl"></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
        t.panel.appendChild(el);
        sfx.play('think');
        humWhileThinking();
        if (t.id === activeTabId[t.surfaceName])
            scrollChat(SURFACES[t.surfaceName]);
    }
    const { letter, tint } = speaker(k, agentId);
    const avatar = $('.avatar', el);
    if (avatar)
        avatar.outerHTML = brandMark('avatar mini', tint, letter);
    const lbl = $('.lbl', el);
    if (lbl)
        swapText(lbl, label);
}
// A quiet murmur every couple of seconds for as long as any agent is still thinking (or writing a commit message).
let thinkingHum;
let commitMsgPending = false;
function humWhileThinking() {
    if (thinkingHum != null)
        return;
    thinkingHum = setInterval(() => {
        if (!commitMsgPending && !document.querySelector('.agent-tab-panel .thinking')) {
            clearInterval(thinkingHum);
            thinkingHum = undefined;
            return;
        }
        sfx.play('hum');
    }, 1800);
}
function hideThinking(tab) {
    if (tab) {
        tab.panel.querySelector('.thinking')?.remove();
    }
    else {
        for (const list of Object.values(surfaceTabs)) {
            for (const t of list)
                t.panel.querySelector('.thinking')?.remove();
        }
    }
}
/* ----- Rotating prompts: a composer's placeholder changes when you point at it (and every 5 s while you do);
   Breeze Space's greeting changes every 5 s ----- */
// Built from parts, so each list holds about a thousand lines without writing them out one by one. Each verb only meets
// the things it makes sense for ("Add types to" meets code, "Restyle" meets screens), so no line reads as nonsense.
const combine = (templates, parts) => templates.flatMap(t => parts.map(p => t.replace('{x}', p)));
const CODE_PARTS = ['the login flow', 'the API client', 'the database queries', 'the build script', 'the router', 'the auth middleware',
    'the image loader', 'the date helpers', 'the cart logic', 'the config loader', 'the state store', 'the form validation',
    'the caching layer', 'the websocket code', 'the logging', 'the cron jobs', 'the upload handler', 'the routes file', 'the data fetching'];
const UI_PARTS = ['the navbar', 'the checkout page', 'the settings screen', 'the search results', 'the signup form', 'the footer',
    'the dashboard charts', 'the error page', 'the mobile layout', 'the sidebar', 'the modal', 'the dark theme', 'the header',
    'the pagination', 'the notifications', 'the profile page', 'the main menu', 'the onboarding steps', 'the pricing page',
    'the email templates', 'the landing hero', 'the color tokens'];
// The IDE composer's own placeholder is a single space: nothing shows under the examples (not even when Ctrl+A
// highlights it), and :placeholder-shown still tells the CSS when the box is empty.
const IDE_PLACEHOLDERS = [
    ...combine(['Build {x}', 'Make {x}', 'Create {x}', 'Design {x}', 'Prototype {x}', 'Scaffold {x}', 'Sketch out {x}', 'Put together {x}', 'Spin up {x}', 'Draft {x}', 'Code up {x}', 'Set up {x}'], [
        'a landing page for a coffee shop', 'a todo app with drag and drop', 'a dark mode toggle', 'a pricing table', 'a contact form with validation',
        'a weather widget', 'a Markdown previewer', 'a login screen', 'a REST API for notes', 'a CLI that renames photos',
        'a Pomodoro timer', 'a chat UI', 'a settings page', 'an image gallery with a lightbox', 'a kanban board',
        'a budget tracker', 'a quiz game', 'a snake game', 'a portfolio site', 'a blog with tags',
        'a search bar with suggestions', 'a file uploader', 'a calendar view', 'a charts dashboard', 'a recipe finder',
        'a URL shortener', 'a habit tracker', 'a music player UI', 'a modal dialog', 'a toast notification system',
        'an onboarding flow', 'a 404 page', 'a signup form', 'a countdown timer', 'a color palette generator',
        'a password generator', 'a unit converter', 'a tip calculator', 'a drawing canvas', 'a typing speed test',
        'a product card grid', 'a sidebar navigation', 'a responsive navbar', 'a FAQ accordion', 'a star rating widget',
        'a QR code generator', 'a weather app', 'an expense splitter', 'a mini spreadsheet', 'a memory card game',
    ]),
    ...combine(['Fix {x}', 'Refactor {x}', 'Clean up {x}', 'Simplify {x}', 'Review {x}'], [...CODE_PARTS, ...UI_PARTS, 'the file upload', 'the test suite', 'the drag and drop', 'the keyboard shortcuts']),
    ...combine(['Speed up {x}', 'Write tests for {x}', 'Document {x}', 'Add types to {x}', 'Explain {x}', 'Add error handling to {x}'], CODE_PARTS),
    ...combine(['Restyle {x}', 'Polish {x}'], UI_PARTS),
];
const BOX_PLACEHOLDERS = [
    'Ask Breeze anything',
    ...combine(['How do I {x}?', 'Help me {x}', 'Can you {x}?', 'Show me how to {x}', 'Explain how to {x}', "What's the best way to {x}?", 'Walk me through how to {x}', 'Teach me to {x}', 'Quick: how do I {x}?', 'Is there an easy way to {x}?',
        'I want to {x}', 'Remind me how to {x}', "What's a clean way to {x}?", 'Help me figure out how to {x}', 'Write code to {x}', 'Give me an example of how to {x}', 'Step by step, how do I {x}?', "What's the fastest way to {x}?", 'Can you help me {x}?', 'Show me the right way to {x}'], [
        'center a div', 'set up a Python venv', 'write a regex for emails', 'deploy to Vercel', 'read a CSV file',
        'debounce a search box', 'fix a merge conflict', 'undo my last commit', 'add dark mode', 'call an API in JavaScript',
        'sort a list of objects', 'use async/await', 'write a SQL join', 'parse JSON safely', 'set up ESLint',
        'speed up my page', 'write unit tests', 'build a REST API', 'handle form errors', 'resize images',
        'use TypeScript generics', 'use CSS grid', 'make a responsive layout', 'store passwords safely', 'schedule a cron job',
        'rename files in bulk', 'read environment variables', 'connect to Postgres', 'paginate results', 'upload files',
        'send an email from Node', 'profile slow code', 'write a Dockerfile', 'rebase a branch', 'cache API responses',
        'validate user input', 'animate a button', 'build a CLI', 'scrape a web page', 'use WebSockets',
        'format dates', 'write a bash script', 'handle time zones', 'make a chart', 'lazy load images',
        'set up GitHub Actions', 'write good commit messages', 'organize my project folders', 'find a memory leak', 'turn callbacks into promises',
    ]),
];
const BOX_HEADINGS = [
    'What can I help with?',
    ...combine(['Ready to {x}?', "Let's {x}", 'Shall we {x}?', 'Want to {x}?', 'How about we {x}?', 'Time to {x}', "Today, let's {x}", 'What if we {x}?', 'Care to {x}?', "Let's {x} together",
        "Ready? Let's {x}", 'Mind if we {x}?', 'Why not {x}?', 'Shall we {x} today?', 'Want to {x} today?', "Let's {x} now", 'Ready to {x} today?', 'Should we {x}?', 'Could we {x}?', "Let's {x}, shall we?"], [
        'build something', 'ship it', 'fix that bug', 'make it faster', 'write some code', 'try an idea', 'clean things up', 'start fresh', 'make it pretty', 'learn something',
        'squash bugs', 'plan a feature', 'sketch an app', 'tidy the code', 'write the tests', 'go further', 'dream big', 'launch it', 'make it work', 'make it right',
        'explore an idea', 'prototype fast', 'refactor boldly', 'debug together', 'design a page', 'code something fun', 'automate a chore', 'build a game', 'polish the UI', 'solve a puzzle',
        'start a project', 'finish that feature', 'break it down', 'make magic', 'craft an API', 'build a tool', 'write the docs', 'speed things up', 'get unstuck', 'try something new',
        'ship today', 'cook up an app', 'fix the build', 'make a website', 'level up', 'pair up', 'brainstorm', 'untangle the mess', 'go live', 'make it shine',
    ]),
];
function pickOther(list, current) {
    const r = new Uint32Array(1);
    for (;;) {
        crypto.getRandomValues(r);
        const next = list[r[0] % list.length];
        if (next !== current || list.length < 2)
            return next;
    }
}
// Blurs the old text away, then the new text in.
function blurSwap(el, text) {
    if (el.textContent === text)
        return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !el.isConnected) {
        el.textContent = text;
        return;
    }
    el.getAnimations().forEach(a => { if (a.id === 'blurSwap')
        a.cancel(); });
    const out = el.animate([{ opacity: 1, filter: 'blur(0)', transform: 'none' }, { opacity: 0, filter: 'blur(6px)', transform: 'translateY(-3px)' }], { duration: 220, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    out.id = 'blurSwap';
    out.onfinish = () => {
        el.textContent = text;
        out.cancel();
        const into = el.animate([{ opacity: 0, filter: 'blur(6px)', transform: 'translateY(3px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        into.id = 'blurSwap';
    };
}
function rotatePlaceholder(ta, home, list) {
    const layer = document.createElement('span');
    layer.className = 'ph-rot';
    layer.setAttribute('aria-hidden', 'true');
    layer.textContent = list.includes(home) ? home : pickOther(list, '');
    ta.after(layer);
    const place = () => {
        const cs = getComputedStyle(ta);
        const px = (v) => Number.parseFloat(v) || 0;
        layer.style.top = `${ta.offsetTop + px(cs.borderTopWidth) + px(cs.paddingTop)}px`;
        layer.style.left = `${ta.offsetLeft + px(cs.borderLeftWidth) + px(cs.paddingLeft)}px`;
        layer.style.width = `${Math.max(0, ta.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight))}px`;
        layer.style.font = cs.font;
        layer.style.lineHeight = cs.lineHeight;
    };
    const sync = () => ta.classList.toggle('ph-rotating', ta.placeholder === home);
    new ResizeObserver(place).observe(ta);
    new MutationObserver(sync).observe(ta, { attributes: true, attributeFilter: ['placeholder'] });
    place();
    sync();
    const r = { ta, list, layer };
    let hoverTimer;
    ta.addEventListener('pointerenter', () => {
        nextPlaceholder(r);
        clearInterval(hoverTimer);
        hoverTimer = setInterval(() => nextPlaceholder(r), 5000);
    });
    ta.addEventListener('pointerleave', () => { clearInterval(hoverTimer); hoverTimer = undefined; });
    // Typing mid-swap: drop the swap so the placeholder can blur away at once.
    ta.addEventListener('input', () => layer.getAnimations().forEach(a => { if (a.id === 'blurSwap')
        a.cancel(); }));
}
function nextPlaceholder(r) {
    if (r.ta.value || !r.ta.classList.contains('ph-rotating'))
        return;
    blurSwap(r.layer, pickOther(r.list, r.layer.textContent ?? ''));
}
rotatePlaceholder(SURFACES.ide.prompt, ' ', IDE_PLACEHOLDERS);
rotatePlaceholder(SURFACES.box.prompt, BOX_PLACEHOLDERS[0], BOX_PLACEHOLDERS);
setInterval(() => {
    if (document.hidden)
        return;
    for (const h of $$('#boxChat .empty h4'))
        if (h.offsetParent)
            blurSwap(h, pickOther(BOX_HEADINGS, h.textContent ?? ''));
}, 5000);
function boxEmptyWho() {
    const agent = selectedAgent();
    return agent ? `Breeze Space talks to ${agent.name}. Pick another agent below.` : 'Pick an agent below to start.';
}
// The greeting is BOX_HEADINGS[0], written out: a tab can be made before that list exists.
function boxEmptyHtml() {
    return `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="56" height="56"><h4>What can I help with?</h4><div class="empty-who">${esc(boxEmptyWho())}</div></div></div>`;
}
// Picking another agent rewrites the line under the greeting in place, with the same blur.
function updateBoxEmptyWho() {
    for (const el of $$('#boxChat .empty-who'))
        blurSwap(el, boxEmptyWho());
}
function emptyChat(s = SURFACES.ide, tab) {
    const t = tab || getActiveTab(s);
    if (s.name === 'box') {
        t.panel.innerHTML = boxEmptyHtml();
        return;
    }
    t.panel.innerHTML = `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div class="empty-line">Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
// A small, safe subset of Markdown for agent replies: inline code, bold and line breaks. Fenced code blocks
// become artifacts: a card with the file name, Copy and Download. A fence may name its file: ```html index.html
const inlineMd = (s) => esc(s).replaceAll(/`([^`\n]+)`/g, '<code>$1</code>').replaceAll(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replaceAll('\n', '<br>');
function md(text) {
    const out = [];
    let last = 0;
    // An unclosed fence (the reply was cut off) still shows its code.
    for (const m of text.matchAll(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g)) {
        out.push(inlineMd(text.slice(last, m.index)), artifactHtml(m[1].trim(), m[2].replace(/\n$/, '')));
        last = m.index + m[0].length;
    }
    out.push(inlineMd(text.slice(last)));
    return out.join('');
}
const LANG_EXT = {
    javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', html: 'html', css: 'css',
    json: 'json', markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', ps1: 'ps1', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    java: 'java', go: 'go', rust: 'rs', rs: 'rs', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', svg: 'svg', csharp: 'cs', cs: 'cs', php: 'php', ruby: 'rb',
};
// "html index.html", "index.html" or "python": the file name to show and to save as.
function artifactName(info) {
    const [first = '', second = ''] = info.split(/\s+/);
    const named = [second, first].find(t => /^[\w.-]+\.\w+$/.test(t) && !/^\.+$/.test(t));
    if (named)
        return named;
    return `snippet.${LANG_EXT[first.toLowerCase()] ?? 'txt'}`;
}
function artifactHtml(info, code) {
    const name = artifactName(info);
    const lines = code ? code.split('\n').length : 0;
    return `<div class="artifact"><div class="artifact-head"><span class="ico">${fileIcon(name)}</span><span class="artifact-name">${esc(name)}</span><span class="artifact-meta">${plural(lines, 'line')}</span>`
        + `<button class="icon-btn" data-artifact="copy" title="Copy">${svgIcon('copy')}</button><button class="icon-btn" data-artifact="download" title="Download ${escAttr(name)}">${svgIcon('download')}</button></div>`
        + `<pre>${esc(code)}</pre></div>`;
}
// Works for replies restored from a saved chat too: the code is read back from the card itself.
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-artifact]');
    const card = btn?.closest('.artifact');
    if (!btn || !card)
        return;
    const code = $('pre', card).textContent ?? '';
    const name = $('.artifact-name', card).textContent ?? 'snippet.txt';
    if (btn.dataset.artifact === 'copy') {
        navigator.clipboard.writeText(code).then(() => {
            void setIcon(btn, 'check');
            setTimeout(() => void setIcon(btn, 'copy'), 1400);
        }, () => toast('Couldn’t copy to the clipboard'));
        return;
    }
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
});
const TOOL_ICON = { read: 'eye', edit: 'pencil', run: 'terminal', search: 'search', web: 'globe', todo: 'todo', agent: 'diamond', tool: 'dot', note: 'info' };
function toolLine(kind, label, tab) {
    sfx.play('tool');
    addMsg(`<div class="tool-line ${kind}"><span class="ti">${svgIcon(TOOL_ICON[kind] ?? 'dot', 14)}</span><span class="tl">${esc(label)}</span></div>`, tab);
}
// The open chat is kept per project folder (and once for Breeze Space) so a reload brings it back.
const chatScope = (s) => (s.name === 'box' ? 'box' : rootInfo?.root ?? '');
const chatKey = (s = msgSurface) => `breeze.chat:${chatScope(s)}`;
const agentSessionKey = (s = msgSurface, agent = appState.agent) => `breeze.agentSession:${chatScope(s)}:${agent ?? ''}`;
