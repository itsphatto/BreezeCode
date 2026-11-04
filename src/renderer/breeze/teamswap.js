"use strict";
/* ================= Into and out of the debugger: a small team rebuilds the window ================= */
// swapScreen plays this between the IDE and the debugger, like watching people work in a shared design file: a few
// mouse cursors take the panels one at a time, cropping or dragging the old ones away and drawing or dropping the new
// ones in. A panel in the same place with the same content on both screens is never touched, and one that has only
// changed place is just dragged over. The panels are the real elements, clipped and moved without any layout; the
// cursors and selection boxes are drawn on one canvas above them.
const TEAM_BLOCKS = '#logoHome, #menubar, #projectName, #updateBtn, .space-btn, .layout-btns, #avatars, #sidebar, #editorPane, #previewPane, #terminal, #agents, .statusbar, #settingsBtn, [data-rail="settingsBtn"], #dbgTools, #dbgWhat, #dbgBack, #dbgStackPanel, #dbgBpPanel, #dbgCenter, #dbgBottom, #dbgVarsPanel, #dbgWatchPanel';
const TEAM_CREW = [
    { name: 'Planner', colour: '#c084fc', to: '#6366f1' }, { name: 'Builder', colour: '#38bdf8', to: '#2563eb' }, { name: 'Assistant', colour: '#34d399', to: '#0891b2' },
    { name: 'Reviewer', colour: '#fbbf24', to: '#f97316' }, { name: 'Tester', colour: '#f472b6', to: '#e11d48' },
];
const TEAM_HOLD_MS = 50; // a beat with the block selected before the drag starts
const TEAM_REST_MS = 30; // and one after letting go
const TEAM_EXIT_MS = 220; // the crew leaving the window
// The cursor's corners as x, y and how round. The hot spot, (0, 0), is just inside the rounded tip.
const TEAM_ARROW = [[-2, -2.5, 2.5], [-2, 18.5, 2.5], [5, 12.5, 2], [15, 11, 2]];
function teamArrow() {
    const path = new Path2D(), last = TEAM_ARROW[TEAM_ARROW.length - 1];
    path.moveTo((last[0] + TEAM_ARROW[0][0]) / 2, (last[1] + TEAM_ARROW[0][1]) / 2);
    TEAM_ARROW.forEach(([x, y, r], i) => {
        const next = TEAM_ARROW[(i + 1) % TEAM_ARROW.length];
        path.arcTo(x, y, next[0], next[1], r);
    });
    path.closePath();
    return path;
}
function crewHand() {
    const el = document.createElement('div'), arrow = document.createElement('canvas'), tag = document.createElement('span');
    el.className = 'type-hand';
    el.setAttribute('aria-hidden', 'true');
    tag.className = 'type-hand-tag';
    el.append(arrow, tag);
    return { el, arrow, tag, who: '' };
}
function dressCrewHand(hand, phase) {
    const crew = TEAM_CREW.find(c => c.name.toLowerCase() === phase) ?? TEAM_CREW[2];
    if (hand.who === crew.name)
        return;
    hand.who = crew.name;
    hand.tag.textContent = crew.name;
    hand.tag.style.background = `linear-gradient(90deg, ${crew.colour}, ${crew.to})`;
    const dpr = devicePixelRatio || 1, g = hand.arrow.getContext('2d');
    hand.arrow.width = 20 * dpr; // also clears it
    hand.arrow.height = 24 * dpr;
    g.scale(dpr, dpr);
    g.translate(3, 3); // the hot spot: the arrow reaches up and left of it
    const paint = g.createLinearGradient(-2, -2.5, 15, 18.5);
    paint.addColorStop(0, crew.colour);
    paint.addColorStop(1, crew.to);
    g.fillStyle = paint;
    g.fill(teamArrow());
}
function teamBlocks(screen) {
    return Array.from(screen.querySelectorAll(TEAM_BLOCKS)).filter(el => el.checkVisibility()).map(el => {
        const r = el.getBoundingClientRect(), shows = `${el.textContent?.trim()}${el.querySelector('svg')?.innerHTML ?? ''}`;
        return { el, x: r.left, y: r.top, w: r.width, h: r.height, key: `${[r.left, r.top, r.width, r.height].map(Math.round).join()}|${shows}`, look: shows && `${Math.round(r.width)}x${Math.round(r.height)}|${shows}` };
    }).filter(b => b.w > 2 && b.h > 2);
}
// What differs between two screens: anything in the same place with the same content on both is dropped from both.
function changedBlocks(from, to) {
    const inFrom = new Set(from.map(b => b.key)), inTo = new Set(to.map(b => b.key));
    return [from.filter(b => !inTo.has(b.key)), to.filter(b => !inFrom.has(b.key))];
}
// Among what changed, the blocks that only moved: same size and content in a new place. They're taken out of both lists.
function movedBlocks(old, fresh) {
    const left = [...fresh], moved = [];
    const stay = old.filter(from => {
        const i = from.look ? left.findIndex(n => n.look === from.look) : -1;
        if (i < 0)
            return true;
        moved.push({ from, to: left.splice(i, 1)[0] });
        return false;
    });
    return { old: stay, fresh: left, moved };
}
// The block and the hand on it at p (0 to 1) through a task.
function teamShape(t, p) {
    const b = t.block, shown = t.out ? 1 - p : p;
    if (t.ax < 0 && t.ay < 0) {
        const x = b.x + t.dx * (1 - shown), y = b.y + t.dy * (1 - shown);
        return { x, y, w: b.w, h: b.h, alpha: t.from ? 1 : shown, cx: x + b.w / 2, cy: y + b.h / 2 };
    }
    const w = t.ax < 0 ? b.w : b.w * shown, h = t.ay < 0 ? b.h : b.h * shown;
    const x = t.ax === 1 ? b.x + b.w - w : b.x, y = t.ay === 1 ? b.y + b.h - h : b.y;
    return { x, y, w, h, alpha: 1, cx: t.ax < 0 ? x + w / 2 : t.ax === 0 ? x + w : x, cy: t.ay < 0 ? y + h / 2 : t.ay === 0 ? y + h : y };
}
// Who does what, when. Each old block is followed by the new one taking most of its place, and whoever is free next
// takes the next job, so the window changes a few blocks at a time rather than all at once.
function planTeam(old, fresh, from, random = Math.random, moved = []) {
    const shuffled = (list) => {
        const a = [...list];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };
    const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const left = shuffled(fresh), jobs = [];
    for (const block of shuffled(old)) {
        jobs.push({ block, out: true });
        const areas = left.map(n => overlap(block, n)), most = Math.max(0, ...areas);
        if (most > 0)
            jobs.push({ block: left.splice(areas.indexOf(most), 1)[0], out: false });
    }
    for (const block of left)
        jobs.push({ block, out: false });
    for (const m of moved)
        jobs.splice(Math.floor(random() * (jobs.length + 1)), 0, { block: m.to, from: m.from, out: false });
    const hands = from.map(p => ({ ...p })), free = from.map((_, i) => i * 80);
    return jobs.map(({ block, out, from: was }) => {
        const who = free.indexOf(Math.min(...free)), kind = random(), side = () => (random() < .5 ? 0 : 1);
        const t = { block, from: was, out, who, ax: -1, ay: -1, dx: 0, dy: 0, at: free[who], start: 0, end: 0 };
        if (was) {
            t.dx = was.x - block.x;
            t.dy = was.y - block.y;
        }
        else if (kind < .4) {
            if (block.h < 60 || random() < .5)
                t.ax = side();
            else
                t.ay = side();
        }
        else if (kind < .75 && block.h >= 60) {
            t.ax = side();
            t.ay = side();
        }
        else {
            const far = (side() ? 1 : -1) * 70;
            if (side())
                t.dx = far;
            else
                t.dy = far;
        }
        const s = teamShape(t, 0), e = teamShape(t, 1), hand = hands[who];
        t.start = t.at + Math.min(240, Math.max(110, Math.hypot(s.cx - hand.x, s.cy - hand.y) / 3.5)) + TEAM_HOLD_MS;
        t.end = t.start + Math.min(320, Math.max(170, Math.sqrt(block.w * block.h) / 1.6));
        hands[who] = { x: e.cx, y: e.cy };
        free[who] = t.end + TEAM_REST_MS;
        return t;
    });
}
const teamEase = (p) => (p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
// Where a cursor is at time t: on its way to the next block, working on it, or leaving once its jobs are done.
function teamHand(tasks, from, t) {
    const lerp = (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, down: false });
    let last = from;
    for (const k of tasks) {
        const s = teamShape(k, 0), e = teamShape(k, 1);
        if (t < k.at)
            return lerp(last, last, 0);
        const reach = k.start - TEAM_HOLD_MS;
        if (t < reach)
            return lerp(last, { x: s.cx, y: s.cy }, teamEase((t - k.at) / (reach - k.at)));
        if (t <= k.end) {
            const now = teamShape(k, teamEase(Math.max(0, (t - k.start) / (k.end - k.start))));
            return { x: now.cx, y: now.cy, down: true };
        }
        last = { x: e.cx, y: e.cy };
    }
    const done = tasks.length ? tasks[tasks.length - 1].end + TEAM_REST_MS : 0;
    return lerp(last, from, teamEase(Math.max(0, Math.min(1, (t - done) / TEAM_EXIT_MS))));
}
function paintTeam(g, tasks, from, t, font) {
    g.clearRect(0, 0, innerWidth, innerHeight);
    // Selection boxes: handles on a block being dragged, crop marks on one being cropped, dashes on one being drawn.
    for (const k of tasks) {
        if (t < k.start - TEAM_HOLD_MS || t > k.end + TEAM_REST_MS)
            continue;
        const colour = TEAM_CREW[k.who].colour, s = teamShape(k, teamEase(Math.max(0, Math.min(1, (t - k.start) / (k.end - k.start)))));
        const dragged = k.ax < 0 && k.ay < 0, drawn = !k.out && k.ax >= 0 && k.ay >= 0;
        const corners = [[s.x, s.y, 1, 1], [s.x + s.w, s.y, -1, 1], [s.x, s.y + s.h, 1, -1], [s.x + s.w, s.y + s.h, -1, -1]];
        g.strokeStyle = g.fillStyle = colour;
        g.lineWidth = 1.5;
        g.setLineDash(drawn ? [5, 4] : []);
        if (drawn) {
            g.globalAlpha = .1;
            g.fillRect(s.x, s.y, s.w, s.h);
            g.globalAlpha = 1;
        }
        g.strokeRect(s.x, s.y, s.w, s.h);
        g.setLineDash([]);
        if (drawn)
            continue;
        for (const [x, y, dx, dy] of corners) {
            if (dragged) {
                g.fillStyle = '#fff';
                g.fillRect(x - 3.5, y - 3.5, 7, 7);
                g.strokeRect(x - 3.5, y - 3.5, 7, 7);
            }
            else {
                const arm = Math.min(14, s.w / 2, s.h / 2);
                g.lineWidth = 3;
                g.beginPath();
                g.moveTo(x + dx * arm, y);
                g.lineTo(x, y);
                g.lineTo(x, y + dy * arm);
                g.stroke();
            }
        }
    }
    const arrow = teamArrow();
    g.font = `600 11px ${font}`;
    g.textBaseline = 'middle';
    TEAM_CREW.forEach((c, who) => {
        const hand = teamHand(tasks.filter(k => k.who === who), from[who], t);
        g.save();
        g.translate(hand.x, hand.y);
        if (hand.down)
            g.scale(.88, .88); // the button held down
        const w = g.measureText(c.name).width + 12;
        const fill = (x0, y0, x1, y1) => {
            const paint = g.createLinearGradient(x0, y0, x1, y1);
            paint.addColorStop(0, c.colour);
            paint.addColorStop(1, c.to);
            return paint;
        };
        g.fillStyle = fill(-2, -2.5, 15, 18.5);
        g.fill(arrow);
        g.fillStyle = fill(13, 0, 13 + w, 0);
        g.beginPath();
        g.roundRect(13, 19, w, 18, 9);
        g.fill();
        g.fillStyle = '#fff';
        g.fillText(c.name, 19, 28.5);
        g.restore();
    });
}
// Plays it with `next` above `prev` and calls done when it has finished. Gives back how to stop early, and how long it takes.
function teamSwap(prev, next, done) {
    const [gone, come] = changedBlocks(teamBlocks(prev), teamBlocks(next));
    const { old, fresh, moved } = movedBlocks(gone, come);
    const from = [{ x: -30, y: innerHeight * .3 }, { x: innerWidth + 30, y: innerHeight * .2 }, { x: innerWidth * .3, y: innerHeight + 30 }, { x: innerWidth + 30, y: innerHeight * .8 }, { x: innerWidth * .6, y: -30 }];
    const tasks = planTeam(old, fresh, from, Math.random, moved);
    const touched = tasks.flatMap(k => (k.from ? [k.block, k.from] : [k.block])).map(b => b.el);
    const total = Math.max(0, ...tasks.map(k => k.end)) + TEAM_REST_MS + TEAM_EXIT_MS;
    const font = getComputedStyle(document.body).fontFamily, dpr = devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.className = 'swap-team';
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    document.body.append(canvas);
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const place = (k, p) => {
        const s = teamShape(k, p), b = k.block, el = b.el;
        if (k.ax < 0 && k.ay < 0) {
            el.style.clipPath = '';
            el.style.transform = `translate(${s.x - b.x}px, ${s.y - b.y}px)`;
            el.style.opacity = String(s.alpha);
        }
        else
            el.style.clipPath = `inset(${s.y - b.y}px ${b.x + b.w - s.x - s.w}px ${b.y + b.h - s.y - s.h}px ${s.x - b.x}px)`;
    };
    for (const el of touched)
        el.style.transition = 'none';
    for (const k of tasks) {
        if (k.from) {
            k.from.el.style.clipPath = 'inset(50%)';
            place(k, 0);
        }
        else if (!k.out)
            k.block.el.style.clipPath = 'inset(50%)';
    }
    const t0 = performance.now();
    let frame = 0;
    const tick = (now) => {
        const t = now - t0;
        if (t >= total) {
            done();
            return;
        }
        for (const k of tasks) {
            if (t < k.start)
                continue;
            const el = k.block.el;
            if (t < k.end)
                place(k, teamEase((t - k.start) / (k.end - k.start)));
            else if (k.out) {
                el.style.clipPath = 'inset(50%)';
                el.style.transform = el.style.opacity = '';
            }
            else
                el.style.clipPath = el.style.transform = el.style.opacity = '';
        }
        paintTeam(g, tasks, from, t, font);
        frame = requestAnimationFrame(tick);
    };
    tick(t0);
    return {
        ms: total,
        stop: () => {
            cancelAnimationFrame(frame);
            canvas.remove();
            for (const el of touched)
                el.style.clipPath = el.style.transform = el.style.opacity = el.style.transition = '';
            prev.classList.remove('screen-team');
            next.classList.remove('screen-team');
        },
    };
}
