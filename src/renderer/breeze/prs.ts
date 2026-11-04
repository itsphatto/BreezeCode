/* ================= Source Control page (and pull requests) ================= */
// Source Control is a full page: the changes, commit box and graph in a column on the left (git.ts), and on the right
// whatever was picked there, a file's diff for now and pull requests later. It takes the place of the editor and
// preview, and of the side bar, while it is open. Nothing in `layout` changes, so closing it brings back exactly what
// was on screen before.
let scmPageOpen = false;
// The side-bar view to go back to when the page closes (never 'git': that is the page itself).
let scmPrevView = 'files';

// Swapping the page in or out snaps the columns instead of sliding them: applyLayout sizes the preview from the width
// the work area has right then, which mid-slide is not the width it ends at, and the editor would come back squeezed.
function snapMain(): void {
  const main = $('#main');
  main.classList.add('scm-snap');
  setTimeout(() => main.classList.remove('scm-snap'), 80);
}

function openScmPage(): void {
  if (scmPageOpen) return;
  snapMain();
  scmPrevView = layout.view === 'git' ? 'files' : layout.view;
  scmPageOpen = true;
  $('#main').classList.add('scm-page');
  scmEmptyDetail();
  setTimeout(placeSashes); // the page's own sash and the side bar's now change places
}

// `restore` false: showView is already switching to another view, so there is nothing to go back to.
function closeScmPage(restore = true): void {
  if (!scmPageOpen) return;
  snapMain();
  scmPageOpen = false;
  $('#main').classList.remove('scm-page');
  setTimeout(placeSashes);
  if (restore) showView(scmPrevView);
}

function showScmDetail(html: string, bind?: (el: HTMLElement) => void): void {
  const el = $('#scmDetail');
  el.innerHTML = html;
  el.scrollTop = 0;
  bind?.(el);
}

function scmEmptyDetail(): void {
  showScmDetail(`<div class="empty scm-empty"><div>${svgIcon('gitBranch', 36)}<h4>Select a change or a pull request</h4></div></div>`);
}

$('#scmClose').onclick = () => closeScmPage();
