/*
 * The reader's theme.
 *
 * What the page wears with nothing chosen is whatever `:root` says, which is
 * the theme the picker falls back to - including when what was kept is a theme
 * that has since been renamed away.
 *
 * The choice is applied to the document twice: once by the few lines in the
 * page's `<head>`, before anything is painted in the wrong theme, and again
 * here whenever the picker changes. A module cannot do the first job - it is
 * deferred by definition, and by the time it runs the page has been seen.
 */

const DEFAULT_THEME = 'catppuccin';

export function createTheme({ select }) {
    select.value = document.documentElement.dataset.theme || DEFAULT_THEME;
    if (!select.value) {
        delete document.documentElement.dataset.theme;
        select.value = DEFAULT_THEME;
    }

    select.addEventListener('change', () => {
        const theme = select.value;
        document.documentElement.dataset.theme = theme;
        try {
            localStorage.setItem('srcblocks-theme', theme);
        } catch (error) {
            /* A window that keeps nothing still changes what is on screen. */
        }
    });
}
