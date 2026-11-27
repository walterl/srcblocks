/* The two element helpers the canvas and its menu are both built out of. */

export const element = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) {
        created.className = className;
    }
    if (text !== undefined) {
        created.textContent = text;
    }
    return created;
};

/* One of the icons drawn once in the page, in the colour of what holds it. */
export const glyph = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon-glyph');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
};
