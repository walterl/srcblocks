import { displayName } from './model.js';

/*
 * The floating list of what a search matched. Each result says where it matched
 * - a name, a path, or a line of source - and jumps to that node when clicked.
 */
const WHERE_LABEL = { name: 'name', path: 'path', source: 'source' };

export function createSearchWindow({ root, title, list, close, onJump }) {
    close.addEventListener('click', () => root.setAttribute('hidden', ''));

    return {
        hide() {
            root.setAttribute('hidden', '');
        },

        show({ results, total }, query) {
            root.removeAttribute('hidden');
            title.textContent = summarise(results.length, total, query);
            list.replaceChildren(...(results.length ? results.map(result => entry(result, onJump)) : [empty(query)]));
        },

        error(message) {
            root.removeAttribute('hidden');
            title.textContent = 'Search';
            list.replaceChildren(labelled('search-empty', message, 'li'));
        },
    };
}

const summarise = (shown, total, query) => {
    const count = shown < total ? `${shown} of ${total}` : `${total}`;
    return `${count} ${total === 1 ? 'match' : 'matches'} for “${query}”`;
};

function entry({ node, path, where, snippet, line }, onJump) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-entry';
    button.addEventListener('click', () => onJump(node.id));

    const heading = document.createElement('div');
    heading.className = 'search-entry-heading';
    heading.append(
        labelled('search-entry-kind', node.kind === 'group' ? 'class' : node.kind),
        labelled('search-entry-name', displayName(node)),
        labelled('search-entry-where', WHERE_LABEL[where]),
    );

    button.append(heading, labelled('search-entry-path', path));
    if (where === 'source') {
        button.append(labelled('search-entry-snippet', `${line}: ${snippet}`));
    }
    item.append(button);
    return item;
}

const empty = query => labelled('search-empty', `Nothing matches “${query}”.`, 'li');

function labelled(className, text, tag = 'span') {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}
