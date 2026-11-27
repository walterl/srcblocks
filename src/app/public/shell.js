/*
 * The apparatus every other part of the page borrows: how it talks to the
 * server, how it says what it is doing, and how the frames around the canvas
 * open and shut.
 *
 * None of it is about the graph. It is here so that the modules that are about
 * the graph do not each carry their own copy.
 */

export const getJson = async url => {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.error || response.statusText);
    }
    return payload;
};

export const isOpen = element => !element.hasAttribute('hidden');

/* Sidebar sections fold away; what is not being used gets out of the way. */
export function setPanelOpen(panel, open) {
    panel.classList.toggle('open', open);
    panel.querySelector('.panel-header').setAttribute('aria-expanded', String(open));
    panel.querySelector('.panel-chevron').textContent = open ? '▾' : '▸';
}

export function toggleMembership(set, id, force) {
    const next = force === undefined ? !set.has(id) : force;
    if (next) {
        set.add(id);
    } else {
        set.delete(id);
    }
}

/*
 * `disableWhileLoading` is whatever must not be touched mid-parse. The pickers
 * pass themselves in rather than being reached for from here: what has to be
 * held shut is a fact about those controls, not about the spinner.
 */
export function createShell({ statusText, loading, loadingText, sidebarToggle, disableWhileLoading = [] }) {
    /*
     * The one line the bar reports on, out of parts that read as one sentence
     * with a dot between them. A part can be markup and not only text, because
     * a diffstat says what it is by its colour.
     */
    const setStatus = (...parts) => {
        statusText.replaceChildren(...parts.flatMap((part, index) => (index ? ['  ·  ', part] : [part])));
    };

    const reportError = err => setStatus(`Error: ${err.message}`);

    /*
     * What is being waited for, said over the canvas it is going to replace.
     *
     * The branch and base pickers are held shut while it runs: a second branch
     * chosen mid-parse would land on the canvas the first one was building.
     */
    async function whileLoading(message, work) {
        loadingText.textContent = message;
        loading.removeAttribute('hidden');
        for (const control of disableWhileLoading) {
            control.disabled = true;
        }
        setStatus(message);

        try {
            return await work();
        } finally {
            loading.setAttribute('hidden', '');
            for (const control of disableWhileLoading) {
                control.disabled = false;
            }
        }
    }

    /* Folds the sidebar away to give the canvas the whole window. */
    function toggleSidebar() {
        const collapsed = document.body.classList.toggle('sidebar-collapsed');
        sidebarToggle.classList.toggle('flipped', collapsed);
        sidebarToggle.title = collapsed ? 'Show the sidebar' : 'Hide the sidebar';
    }

    for (const header of document.querySelectorAll('.panel-header')) {
        header.addEventListener('click', () => {
            const panel = header.closest('.panel');
            setPanelOpen(panel, header.getAttribute('aria-expanded') !== 'true');
        });
    }
    sidebarToggle.addEventListener('click', toggleSidebar);

    return { setStatus, reportError, whileLoading };
}
