import { copyText } from './clipboard.js';
import { getJson, setPanelOpen, toggleMembership } from './shell.js';

/*
 * Choosing what the canvas is showing: which branch, what it is read against,
 * and which of its commits count.
 *
 * All three are the same act of choosing, and all three end in a render, which
 * is why they are one panel and one module.
 */
export function createBranchPanel({
    state,
    elements,
    whileLoading,
    reportError,
    render,
    loadGraph,
    expandTowardsChanges,
}) {
    function renderBranchOptions() {
        const filter = elements.branchFilter.value.trim().toLowerCase();
        const options = state.repo.branches
            .filter(branch => !filter || branch.name.toLowerCase().includes(filter))
            .map(branch => {
                const option = document.createElement('option');
                option.value = branch.name;
                option.textContent = branch.isDefault ? `${branch.name} (default)` : branch.name;
                return option;
            });
        elements.branchSelect.replaceChildren(...options);
    }

    /*
     * What this branch can be compared against, nearest first: for a branch
     * stacked on another, the one below it in the stack comes first, and the
     * rest of the stack after it. Every other branch follows, however far off,
     * which is what the filter is for - a deploy branch is a long way down a
     * list ordered by how near it is.
     *
     * What the branch is being read against is always offered, filter or no
     * filter: a picker that leaves out what it is currently set to reports
     * something false.
     */
    function renderBaseOptions() {
        const { base, bases } = state.analysis;
        // The default base is origin/main, which the list may carry under its
        // local name alone.
        const current = { name: base.ref, commits: state.analysis.commits.length };
        const candidates = bases?.some(candidate => candidate.name === base.ref) ? bases : [current, ...(bases || [])];
        const filter = elements.baseFilter.value.trim().toLowerCase();

        const options = candidates
            .filter(candidate => candidate.name === base.ref || candidate.name.toLowerCase().includes(filter))
            .map(candidate => {
                const option = document.createElement('option');
                option.value = candidate.name;
                option.textContent =
                    candidate.commits === null ? candidate.name : `${candidate.name} · ${candidate.commits} commits`;
                option.selected = candidate.name === base.ref;
                return option;
            });

        elements.baseSelect.replaceChildren(...options);
        elements.baseField.hidden = false;
    }

    async function selectBranch(branch, { base = null, fold = true } = {}) {
        const query = base ? `&base=${encodeURIComponent(base)}` : '';
        const analysis = await whileLoading(`Reading ${branch} — parsing every commit on it`, () =>
            getJson(`/api/branch?name=${encodeURIComponent(branch)}${query}`),
        );

        state.branch = branch;
        loadGraph(analysis.graph, analysis);
        state.selectedCommits = new Set(analysis.commits.map(commit => commit.sha));
        renderCommitList();
        renderBaseOptions();
        expandTowardsChanges();

        elements.branchSummary.textContent = `${branch} · ${analysis.commits.length} commits`;
        // The choosing is done: fold the list away, leaving what was chosen.
        // Picking a different base is more choosing, so that leaves it open.
        if (fold) {
            setPanelOpen(elements.branchPanel, false);
        }
        await render({ fit: true });
    }

    async function clearBranch() {
        elements.branchSelect.value = '';
        elements.commitsPanel.hidden = true;
        elements.baseField.hidden = true;
        state.branch = null;
        elements.branchSummary.textContent = 'none selected';
        setPanelOpen(elements.branchPanel, true);
        const graph = await whileLoading(`Reading ${state.repo.defaultBranch}`, () =>
            getJson(`/api/graph?ref=${encodeURIComponent(state.repo.defaultBranch)}`),
        );
        loadGraph(graph, null);
        await render({ fit: true });
    }

    function renderCommitList() {
        const { commits, perCommit } = state.analysis;
        elements.commitsPanel.hidden = false;
        elements.commitCount.textContent = `(${commits.length})`;

        const items = commits
            .map(commit => {
                const changed = Object.keys(perCommit[commit.sha]?.nodes || {}).length;
                const item = document.createElement('li');
                const label = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = state.selectedCommits.has(commit.sha);
                checkbox.addEventListener('change', () => {
                    toggleMembership(state.selectedCommits, commit.sha);
                    render();
                });

                const sha = document.createElement('span');
                sha.className = 'commit-sha';
                sha.textContent = commit.shortSha;
                sha.title = 'Copy this hash';
                sha.addEventListener('click', event => copySha(event, sha, commit.shortSha));

                const subject = document.createElement('span');
                subject.className = 'commit-subject';
                subject.textContent = commit.subject;
                label.title = commitTooltip(commit);

                const stats = document.createElement('span');
                stats.className = 'commit-stats';
                stats.textContent = changed ? `${changed}▲` : '';

                label.append(checkbox, sha, subject, stats);
                item.append(label);
                return item;
            })
            .reverse();

        elements.commitList.replaceChildren(...items);
    }

    /* The whole commit message, for the row's tooltip. */
    const commitTooltip = commit =>
        [commit.subject, commit.body, `${commit.author} · ${new Date(commit.date).toLocaleString()}`]
            .filter(Boolean)
            .join('\n\n');

    function setAllCommits(selected) {
        state.selectedCommits = new Set(selected ? state.analysis.commits.map(commit => commit.sha) : []);
        renderCommitList();
        render();
    }

    async function copySha(event, element, shortSha) {
        event.preventDefault();
        event.stopPropagation();
        try {
            if (!(await copyText(shortSha))) {
                return;
            }
            element.textContent = 'copied';
            element.classList.add('copied');
            setTimeout(() => {
                element.textContent = shortSha;
                element.classList.remove('copied');
            }, 900);
        } catch (err) {
            reportError(err);
        }
    }

    elements.branchFilter.addEventListener('input', renderBranchOptions);
    elements.baseFilter.addEventListener('input', renderBaseOptions);
    elements.branchSelect.addEventListener('change', () => {
        if (elements.branchSelect.value) {
            selectBranch(elements.branchSelect.value).catch(reportError);
        }
    });
    elements.baseSelect.addEventListener('change', () => {
        if (state.branch) {
            selectBranch(state.branch, { base: elements.baseSelect.value, fold: false }).catch(reportError);
        }
    });
    elements.branchClear.addEventListener('click', () => clearBranch().catch(reportError));
    elements.commitsAll.addEventListener('click', () => setAllCommits(true));
    elements.commitsNone.addEventListener('click', () => setAllCommits(false));

    return { renderBranchOptions };
}
