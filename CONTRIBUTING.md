# Contributing

## Prerequisites

- Node 22.12 or later
- git 2.24 or later, and `tar`
- A POSIX system - Linux or macOS; on Windows, use WSL
- Chromium or Chrome, for the browser tools in `tools/`

## Setting up

```sh
git clone https://github.com/walterl/srcblocks.git
cd srcblocks
npm ci
```

## Checks

```sh
npm test               # analyser, diff and canvas-model tests
npm run format         # rewrite the JavaScript with Prettier
npm run format:check   # what CI runs: fails on anything Prettier would change
```

CI runs `npm test` on Node 22, 24 and 26, `npm run format:check`, and a
browser smoke test (`tools/themes.js` and `tools/smoke.js` against this
repository). Prettier covers `src`, `test`, `scripts`, `tools` and the
top-level `.js` files; Markdown is not formatted.

## Browser tools

The `tools/` scripts drive the real UI in headless Chromium through
`puppeteer-core` - the browser at `CHROME_PATH`, or `/usr/bin/chromium` when it
is unset - and print what was drawn plus any console error. They expect the
server on `http://localhost:4173`, serving a repository, so start one first:

```sh
SRCBLOCKS_REPO=$PWD npm start
```

Without a screenshot path they save one to the system's temporary directory.

| Script              | Usage                                                            | What it checks                                                                                                        |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tools/smoke.js`    | `node tools/smoke.js [branch] [screenshot]`                      | Loads the app, optionally picks a branch, opens a file and a function, and reports console errors and what was drawn. |
| `tools/focus.js`    | `node tools/focus.js <branch\|-> <node-id\|.class> [screenshot]` | Opens one function's source (`-` for no branch) and screenshots it at 1:1.                                            |
| `tools/interact.js` | `node tools/interact.js <branch> [screenshot]`                   | Dragging, pinning, the wheel, the calls window and copying a commit hash.                                             |
| `tools/themes.js`   | `node tools/themes.js [url]`                                     | Every theme in the picker defines every token the stylesheets use.                                                    |

`tools/interact.js` reads srcblocks's own source, so serve this checkout and
give it a branch that changes `src/git/repo.js`: the calls check hovers a
function there.

`npm run analyze -- /path/to/repo src` prints graph statistics for a checkout:
node and edge counts, typed and untyped calls, and the packages it counts as
services and libraries.

## Code layout

[Code layout](README.md#code-layout) in the README maps each layer to its
files and lists the endpoints. The analyser is under `src/analyze`, git access
in `src/git/repo.js`, the server in `src/app`, and the browser app, which has
no build step, in `src/app/public`.

## Commits

- One self-contained change per commit.
- The subject is a plain-English sentence in the imperative that says what the
  change does, with no prefix. For example:
  - `Keep the cache in the user's cache directory, not the install`
  - `Refuse a revision that git would read as an option`
  - `Mark the words that changed inside an edited line`
- The body says what was wrong and what happens now.
- `npm test` and `npm run format:check` pass on every commit.

## Security issues

Do not open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).
