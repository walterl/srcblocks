/*
 * Puts text on the clipboard.
 *
 * The clipboard API is the way to do this and the way it usually happens. A
 * browser that will not hand it over - a denied permission, a page it does not
 * consider secure, an old build - will still copy a selection, so that is what
 * the fallback makes: a field holding the text, selected, copied and gone.
 */
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return copyBySelection(text);
    }
}

function copyBySelection(text) {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '0';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();

    try {
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        field.remove();
    }
}
