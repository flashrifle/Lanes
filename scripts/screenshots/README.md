# Landing-page screenshots

Real screenshots of the Lanes UI without the native app: the real frontend runs in the Vite dev server and is
loaded in headless Chrome with a fake `window.__TAURI_INTERNALS__`. Every command goes to a small Python
server that runs `git` on a throwaway copy of this repository.

```bash
scripts/screenshots/run.sh          # all shots, both languages -> site/assets/screens/{ko,en}/*.png and site/assets/og.png
scripts/screenshots/run.sh --only main,diff
```

Needs git, Python 3 with Pillow, Node, Google Chrome and `pnpm install`. Ports 1420 (Vite), 1555 and 1556
must be free. Don't run `pnpm tauri dev` at the same time. Set `WORK=<dir>` to keep the throwaway repos.

## Files
| File | What it does |
|---|---|
| `make_repo.py <dir> ko\|en` | Replays this repo's real commits (same changes, dates and messages; the author email becomes the GitHub noreply address) into `<dir>/Lanes`. Some commit groups go onto feature branches merged with `--no-ff`, so the graph has several lines. Adds a bare `origin` (main 2 commits ahead), tag `v0.1.0` and 4 uncommitted files. The English set takes its messages from `messages_en.json`. |
| `server.py --repo <dir> --port N` | Serves the harness page and answers `POST /invoke {cmd, args}` with real git output shaped like `src/types.ts`. Shows the repo as `/Users/dev/Projects/Lanes`. Write commands do nothing. Unknown commands are logged as `[mock] unknown command`. Page errors are logged as `[page] ...`. |
| `index.html` | Loads `shots.js`, then `mock.js`, the React refresh preamble, `@vite/client`, `src/main.tsx` and `driver.js`. |
| `shots.js` | Shot list (size, query) and per-language text. Before the app starts it seeds localStorage: tabs, split sizes, and the `history-session:*` / `diff-session:*` hand-offs. |
| `mock.js` | Fake Tauri runtime: `invoke` goes to the server, and the event plugin runs in the page (`window.__emit(name, payload)`). |
| `driver.js` | Imports the app's own stores from Vite to select a commit, highlight a branch line, select the uncommitted-changes row, type a message, or target the quick-commit popover. |
| `shoot.mjs` | Runs `Chrome --headless=new --screenshot` at 2x for each shot. Shots narrower than Chrome's minimum window width are laid out at 380px and cropped. |
| `og.html` | The 1200x630 Open Graph card. `run.sh` renders it to `site/assets/og.png`. |
| `optimize.py` | Uses pngquant if it is installed, otherwise a 256-colour Pillow palette. |

## Shots
`main` (commit selected, files + details), `highlight` (branch line highlighted), `changes` (local changes and
a typed commit message), `history` (file history in blame mode), `diff` (side-by-side diff window) and `quick`
(menu bar quick commit).

Selected commits and files are picked by message text in `shots.js` (`TEXT`, `CONFIG`). If a future history
moves them out of view, change those values. `make_repo.py` maps its branch plan to the real short hashes. New
commits after the last mapped one are added to `main`.
