/* ================= The crew cursor: an agent typing somewhere ================= */
// A mouse cursor with a name tag in a crew member's colours, shown where an agent is typing (explorer.ts, live.ts).
const TEAM_CREW = [
  { name: 'Planner', colour: '#c084fc', to: '#6366f1' }, { name: 'Builder', colour: '#38bdf8', to: '#2563eb' }, { name: 'Assistant', colour: '#34d399', to: '#0891b2' },
  { name: 'Reviewer', colour: '#fbbf24', to: '#f97316' }, { name: 'Tester', colour: '#f472b6', to: '#e11d48' },
];
// The cursor's corners as x, y and how round. The hot spot, (0, 0), is just inside the rounded tip.
const TEAM_ARROW = [[-2, -2.5, 2.5], [-2, 18.5, 2.5], [5, 12.5, 2], [15, 11, 2]];
function teamArrow(): Path2D {
  const path = new Path2D(), last = TEAM_ARROW[TEAM_ARROW.length - 1];
  path.moveTo((last[0] + TEAM_ARROW[0][0]) / 2, (last[1] + TEAM_ARROW[0][1]) / 2);
  TEAM_ARROW.forEach(([x, y, r], i) => {
    const next = TEAM_ARROW[(i + 1) % TEAM_ARROW.length];
    path.arcTo(x, y, next[0], next[1], r);
  });
  path.closePath();
  return path;
}

// The same cursor as an element, for an agent typing somewhere: its arrow and name tag in the crew member's colours.
// `who` is the crew member it is dressed as; the arrow is only repainted when that changes.
interface CrewHand { el: HTMLElement; arrow: HTMLCanvasElement; tag: HTMLElement; who: string; }
function crewHand(): CrewHand {
  const el = document.createElement('div'), arrow = document.createElement('canvas'), tag = document.createElement('span');
  el.className = 'type-hand';
  el.setAttribute('aria-hidden', 'true');
  tag.className = 'type-hand-tag';
  el.append(arrow, tag);
  return { el, arrow, tag, who: '' };
}
function dressCrewHand(hand: CrewHand, phase: string): void {
  const crew = TEAM_CREW.find(c => c.name.toLowerCase() === phase) ?? TEAM_CREW[2];
  if (hand.who === crew.name) return;
  hand.who = crew.name;
  hand.tag.textContent = crew.name;
  hand.tag.style.background = `linear-gradient(90deg, ${crew.colour}, ${crew.to})`;
  const dpr = devicePixelRatio || 1, g = hand.arrow.getContext('2d') as CanvasRenderingContext2D;
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
