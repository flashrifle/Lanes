# Lanes

A fast, standalone macOS Git log viewer modeled on the JetBrains IDE Git tool window — branch tree, commit graph, filters, changed files, and a side-by-side diff window — without opening an IDE.

Built with Tauri 2 (Rust) + React + TypeScript. It shells out to your system `git`.

## Features
- Branch tree (local / remote / tags, folders by `/`, favorites) with checkout, new branch, delete, fetch, pull
- Commit graph with IntelliJ-style lane layout and "Standard" (Bek) sorting; handles 100k+ commits
- Filters: text/hash (regex, case), branch, user, date, path — filtered history shown with dotted edges
- Changed files tree, commit details, and a separate side-by-side diff window with word-level highlights
- Multiple repositories as tabs; auto-refresh when the repository changes

## Development
```bash
pnpm install
pnpm tauri dev        # run the app
pnpm test             # TS unit tests (graph engine, UI logic, Rust↔TS contract)
cd src-tauri && cargo test
```
Requires Node 20+, pnpm, Rust (stable) and Xcode command line tools.

## Build
```bash
pnpm tauri build      # produces Lanes.app and a .dmg under src-tauri/target/release/bundle/
```

## Credits
The commit graph engine is a TypeScript port of parts of the IntelliJ Platform's VCS log
(Apache License 2.0). See [NOTICE](NOTICE). Lanes is not affiliated with JetBrains.
