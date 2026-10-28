# AGENTS.md — Precise Line Sync

## Project goal

Maintain a local Obsidian desktop plugin that aligns corresponding logical Markdown lines in two horizontally adjacent Live Preview panes. If one logical line wraps taller than its counterpart, the plugin must add view-only vertical space to the shorter side so subsequent line starts remain aligned.

The plugin must:

- map logical line `n` to logical line `n`;
- preserve alignment while scrolling either pane;
- allow the feature to be enabled, disabled, and toggled;
- never modify the Markdown notes;
- avoid visible flashing, oscillation, or scroll feedback loops.

## Important current architecture

- Source implementation: `src/main.js`.
- Built bundle: `main.js`.
- Styling: `styles.css`.
- Plugin metadata: `manifest.json`.
- Build metadata: `package.json` and `package-lock.json`.
- Installed copy:
  `/mnt/Mein/obsidian_vaults/Mein/.obsidian/plugins/precise-line-sync/`
- The vault currently has the plugin registered in:
  `/mnt/Mein/obsidian_vaults/Mein/.obsidian/community-plugins.json`
- Obsidian tested during development: 1.13.7.

The current implementation uses CodeMirror-native state/decorations. It extracts compatible runtime `StateField` and `StateEffect` constructors from an existing Obsidian editor because bundling a second CodeMirror state module does not reliably attach extensions to Obsidian's editor state.

Do not regress to a solution based only on:

- repeatedly mutating `.cm-line` DOM nodes;
- CSS selectors that depend on undocumented line attributes;
- scroll-position percentage matching;
- remapping the follower pane on every scroll event;
- replacing/removing spacer gaps during active scrolling.

Those approaches caused the previous flashing and alignment failures.

## Development commands

From the project root:

```bash
npm install
npm run build
node --check main.js
```

`npm run build` bundles `src/main.js`, externalizing only `obsidian`, and writes `main.js`.

After every successful build, install the built files into the vault:

```bash
cp main.js manifest.json styles.css README.md \
  /mnt/Mein/obsidian_vaults/Mein/.obsidian/plugins/precise-line-sync/
```

Validate that the installed JavaScript parses:

```bash
node --check \
  /mnt/Mein/obsidian_vaults/Mein/.obsidian/plugins/precise-line-sync/main.js
```

## Runtime verification requirements

Static syntax checks are not sufficient. Before considering a change complete, test in Obsidian with two ordinary prose Markdown files, preferably the English/Persian pair under:

```text
publication/There Is No Antimemetics Division/en.md
publication/There Is No Antimemetics Division/fa.md
```

Verify:

1. The plugin loads without an Obsidian open-error or console exception.
2. The status bar reports `Line sync: on` when enabled.
3. Wrapped lines produce persistent gaps on the shorter side.
4. Corresponding visible line starts remain aligned after scrolling either pane.
5. Fast wheel/trackpad scrolling does not flash or oscillate.
6. Scrollbar dragging and keyboard paging do not create feedback loops.
7. Disabling the feature removes decorations and listeners.
8. Re-enabling restores the layout without modifying note contents.
9. Editing a note and resizing a pane do not permanently corrupt alignment.
10. Pair replacement and pane recreation do not silently discard the gap model.

A useful integration check is to compare `cm.coordsAtPos(cm.state.doc.line(n).from).top` for matching logical source lines after scrolling settles. Live Preview can render multiple `.cm-line` elements for one logical block, so raw DOM-element pairing is not authoritative. Differences should normally be within 1–2 CSS pixels for supported ordinary prose.

## Supported scope and boundaries

Supported:

- Obsidian desktop;
- two visible horizontally adjacent Markdown panes;
- Live Preview/editor views;
- ordinary prose, blank lines, headings, and wrapped text;
- line-number correspondence by source line index.

Not guaranteed:

- Reading view, mobile, or pop-out windows;
- semantic paragraph matching when files insert/delete lines;
- tables, embeds, folded sections, math, or other Markdown renderers that combine or replace multiple source lines;
- arbitrary layouts with more than two relevant visible panes.

If arbitrary Markdown rendering becomes a requirement, consider a separate custom paired reader with one shared vertical layout. Do not silently promise exact native-editor alignment for block renderers that do not preserve one visible block per logical source line.

## Change discipline

- Edit `src/main.js`, not the generated `main.js`.
- Rebuild and copy the bundle to the vault after source changes.
- Keep the installed copy and project copy identical.
- Do not modify user notes or their frontmatter.
- Do not commit or add vault-specific `data.json` to the project source.
- Preserve the enable/disable commands and the Settings tab.
- Keep all alignment work view-only and offline.
- Use the smallest change that can be verified in an actual Obsidian runtime.

## Debugging guidance

If the plugin loads but gaps do not appear:

- confirm that the native runtime line-gap field is attached to both editor views;
- inspect the gap map sizes for both panes;
- inspect the CodeMirror decoration set and computed padding on a line with a known gap;
- verify that the source and installed bundles are identical;
- fully restart/reload Obsidian after changing bundled plugin code.

If the plugin flashes or oscillates:

- stop recalculating gaps on every scroll event;
- ensure layout/measurement-driven scrolls cannot elect a new scroll leader;
- preserve a logical-line anchor during layout refinement;
- prevent stale callbacks from an old pair or generation from changing the current pair;
- do not clear a stable gap map merely because CodeMirror virtualized a DOM node.

If blocked, report the exact runtime error, Obsidian version, pane layout, files used, and validation attempted instead of applying another unverified DOM heuristic.
