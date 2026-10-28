/*
 * Precise Line Sync
 *
 * Keeps the same logical line at the same vertical position in two
 * horizontally adjacent Obsidian Live Preview panes. The panes do not have
 * to have the same line heights: wrapped lines are allowed to create the
 * natural vertical gaps required to keep corresponding line numbers aligned.
 */

const {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} = require("obsidian");
const { Decoration } = require("@codemirror/view");

let runtimeEditorView = null;
let runtimeStateEffect = null;
let runtimeLineGapEffect = null;
let runtimeLineGapField = null;

function makeLineGapDecorations(state, gaps) {
  const ranges = [];
  for (const gap of gaps) {
    if (!gap || gap.gap <= 0.5) continue;
    try {
      const line = state.doc.line(gap.line + 1);
      ranges.push(
        Decoration.line({
          attributes: {
            class: "precise-line-sync-gap",
            style: `padding-bottom: ${gap.gap}px !important;`,
          },
        }).range(line.from),
      );
    } catch (_error) {
      // The document may have changed between measurement and dispatch.
    }
  }
  return Decoration.set(ranges, true);
}

function findRuntimeStateFieldConstructor(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (
    typeof value.constructor?.define === "function" &&
    "createF" in value &&
    "updateF" in value
  ) {
    return value.constructor;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findRuntimeStateFieldConstructor(item, seen);
      if (result) return result;
    }
  } else if (seen.size < 2000) {
    for (const key of Object.keys(value)) {
      const result = findRuntimeStateFieldConstructor(value[key], seen);
      if (result) return result;
    }
  }
  return null;
}

function findRuntimeStateEffectConstructor(cm) {
  const base = cm.state.config?.base;
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    if (typeof value.reconfigure === "function") {
      try {
        const effect = value.reconfigure([]);
        if (typeof effect?.constructor?.define === "function") {
          return effect.constructor;
        }
      } catch (_error) {
        // Continue searching other configuration compartments.
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = visit(item);
        if (result) return result;
      }
    } else if (seen.size < 2000) {
      for (const key of Object.keys(value)) {
        const result = visit(value[key]);
        if (result) return result;
      }
    }
    return null;
  };
  return visit(base);
}

function ensureRuntimeLineGapExtension(cm) {
  if (runtimeLineGapField && runtimeLineGapEffect) return true;
  runtimeEditorView = cm.constructor;
  const fieldConstructor = findRuntimeStateFieldConstructor(
    cm.state.config?.base,
  );
  runtimeStateEffect = findRuntimeStateEffectConstructor(cm);
  if (!fieldConstructor || !runtimeStateEffect) return false;

  runtimeLineGapEffect = runtimeStateEffect.define();
  runtimeLineGapField = fieldConstructor.define({
    create: () => Decoration.none,
    update(decorations, transaction) {
      let next = decorations.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(runtimeLineGapEffect)) {
          next = makeLineGapDecorations(transaction.state, effect.value);
        }
      }
      return next;
    },
    provide: (field) => runtimeEditorView.decorations.from(field),
  });
  return true;
}

const DEFAULT_SETTINGS = {
  enabled: false,
  anchorOffset: 28,
};

let paneSequence = 0;

class PreciseLineSyncPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lineGapField = null;
    this.editorExtensionRegistered = false;
    this.active = Boolean(this.settings.enabled);
    this.pair = null;
    this.detachPairListeners = null;
    this.refreshTimer = null;

    this.status = this.addStatusBarItem();
    this.status.addClass("precise-line-sync-status");
    this.updateStatus();

    this.addCommand({
      id: "toggle-line-alignment",
      name: "Toggle line alignment",
      callback: () => this.setEnabled(!this.active),
    });

    this.addCommand({
      id: "enable-line-alignment",
      name: "Enable line alignment",
      callback: () => this.setEnabled(true),
    });

    this.addCommand({
      id: "disable-line-alignment",
      name: "Disable line alignment",
      callback: () => this.setEnabled(false),
    });

    this.addSettingTab(new PreciseLineSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshPair()),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshPair()),
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, _change, view) => {
        if (
          this.active &&
          this.pair &&
          (view === this.pair.left.view || view === this.pair.right.view)
        ) {
          const changedPane =
            view === this.pair.left.view ? this.pair.left : this.pair.right;
          changedPane.naturalHeights.clear();
          this.scheduleIdleAlignment(this.pair);
        }
      }),
    );

    // Obsidian can replace editor DOM nodes without emitting a layout event.
    // A low-frequency refresh keeps the plugin attached after such changes.
    this.refreshTimer = window.setInterval(() => this.refreshPair(), 1200);
    this.registerInterval(this.refreshTimer);

    this.app.workspace.onLayoutReady(() => {
      if (this.active) {
        this.refreshPair();
      }
    });
  }

  onunload() {
    this.detachPair();
  }

  async setEnabled(enabled, notify = true) {
    enabled = Boolean(enabled);
    this.active = enabled;
    this.settings.enabled = enabled;
    await this.saveData(this.settings);

    if (!enabled) {
      this.detachPair();
      if (notify) new Notice("Precise line sync disabled");
      this.updateStatus();
      return;
    }

    this.refreshPair();
    this.updateStatus();

    if (notify) {
      if (this.pair) {
        new Notice("Precise line sync enabled");
      } else {
        new Notice(
          "Precise line sync enabled. Open two side-by-side Live Preview notes.",
        );
      }
    }
  }

  updateStatus() {
    if (!this.status) return;
    this.status.setText(this.active ? "Line sync: on" : "Line sync: off");
    this.status.toggleClass("is-active", this.active);
    this.status.setAttribute(
      "aria-label",
      this.active
        ? "Precise line sync is enabled"
        : "Precise line sync is disabled",
    );
  }

  refreshPair() {
    if (!this.active) return;

    const next = findHorizontalPair(this.app.workspace);
    if (samePair(this.pair, next)) return;

    // CodeMirror may replace only the scroller DOM node while retaining the
    // same editor view. Preserve the measured logical-line gaps in that case;
    // otherwise the first re-render would erase the entire layout.
    const sameViews = sameViewPair(this.pair, next);
    const oldPair = this.pair;
    if (sameViews && oldPair && next) {
      next.left.gaps = oldPair.left.gaps;
      next.right.gaps = oldPair.right.gaps;
      next.left.naturalHeights = oldPair.left.naturalHeights;
      next.right.naturalHeights = oldPair.right.naturalHeights;
      next.left.lastScrollTop = next.left.scroller.scrollTop;
      next.right.lastScrollTop = next.right.scroller.scrollTop;
      this.detachPair(false);
    } else {
      this.detachPair();
    }
    this.pair = next;

    if (!next) return;

    this.attachPair(next);

    // Align the pane containing the active leaf to the other pane initially.
    window.requestAnimationFrame(() => {
      if (!this.active || this.pair !== next) return;
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const source = activeView === next.left.view ? next.left : next.right;
      const target = source === next.left ? next.right : next.left;
      this.lastSource = source;
      this.scheduleIdleAlignment(next, source, target);
    });
  }

  attachPair(pair) {
    this.ensureNativeEditorExtension(pair.left);
    this.ensureNativeEditorExtension(pair.right);
    const onLeftScroll = () => this.onScroll(pair, pair.left, pair.right);
    const onRightScroll = () => this.onScroll(pair, pair.right, pair.left);

    pair.left.scroller.addEventListener("scroll", onLeftScroll, {
      passive: true,
    });
    pair.right.scroller.addEventListener("scroll", onRightScroll, {
      passive: true,
    });
    // CodeMirror decorations persist through DOM virtualization, so a
    // MutationObserver is not needed here. Re-measure after a resize instead.
    const mutationObserver = null;

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (this.active && this.pair === pair) {
              pair.left.naturalHeights.clear();
              pair.right.naturalHeights.clear();
              this.scheduleIdleAlignment(pair);
            }
          })
        : null;

    if (resizeObserver) {
      resizeObserver.observe(pair.left.scroller);
      resizeObserver.observe(pair.right.scroller);
    }

    this.detachPairListeners = (clearGaps = true) => {
      pair.left.scroller.removeEventListener("scroll", onLeftScroll);
      pair.right.scroller.removeEventListener("scroll", onRightScroll);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (pair.alignmentFrame != null) {
        window.cancelAnimationFrame(pair.alignmentFrame);
        pair.alignmentFrame = null;
      }
      if (pair.alignmentIdleTimer != null) {
        window.clearTimeout(pair.alignmentIdleTimer);
        pair.alignmentIdleTimer = null;
      }
      if (pair.alignmentRefreshTimer != null) {
        window.clearTimeout(pair.alignmentRefreshTimer);
        pair.alignmentRefreshTimer = null;
      }
      if (clearGaps) {
        clearPaneGaps(pair.left);
        clearPaneGaps(pair.right);
      }
    };
  }

  detachPair(clearGaps = true) {
    this.detachPairListeners?.(clearGaps);
    this.detachPairListeners = null;
    this.pair = null;
  }

  ensureNativeEditorExtension(pane) {
    if (pane.nativeExtensionAttached) {
      const cm = getCodeMirror(pane);
      if (cm?.state.field(runtimeLineGapField, false)) return;
    }
    const cm = getCodeMirror(pane);
    if (!cm || !attachRuntimeLineGapField(cm)) {
      pane.nativeExtensionAttached = false;
      return;
    }
    pane.nativeExtensionAttached = true;
    this.lineGapField = runtimeLineGapField;
    this.editorExtensionRegistered = true;
  }

  onScroll(pair, source, target) {
    if (!this.active || this.pair !== pair) {
      // The pair may have been replaced between a DOM event and the refresh
      // timer. Ignore the event; the next refresh will attach the new pair.
      return;
    }

    const currentScrollTop = source.scroller.scrollTop;
    if (source.pendingTarget != null) {
      const expected = source.pendingTarget;
      source.pendingTarget = null;
      source.lastScrollTop = currentScrollTop;
      if (Math.abs(currentScrollTop - expected) < 2) return;
    }

    if (source.isProgrammatic || pair.isApplyingLayout) {
      source.lastScrollTop = currentScrollTop;
      return;
    }

    const delta = currentScrollTop - source.lastScrollTop;
    source.lastScrollTop = currentScrollTop;
    this.lastSource = source;

    // Once the gaps have been built, both panes have the same effective
    // height per logical line. During a wheel/trackpad gesture, propagate the
    // pixel delta instead of repeatedly remapping the current line. Repeated
    // absolute remapping is what causes visible oscillation while scrolling.
    if (Math.abs(delta) > 0.1) {
      this.applyScroll(
        target,
        clamp(
          target.scroller.scrollTop + delta,
          0,
          Math.max(0, target.scroller.scrollHeight - target.scroller.clientHeight),
        ),
      );
    }

    // Refine the gap model only after the gesture settles, when newly visible
    // wrapped lines have real measured heights. Never rebuild it per scroll
    // event.
    this.scheduleIdleAlignment(pair, source, target);
  }

  syncFrom(source, target) {
    if (!this.active || !this.pair) return;

    const anchor = getLineAnchor(source, this.settings.anchorOffset);
    if (!anchor) return;

    const targetBlock = getLineBlock(target, anchor.line);
    if (!targetBlock) return;

    const desiredScrollTop = clamp(
      targetBlock.top - anchor.viewportTop,
      0,
      Math.max(0, target.scroller.scrollHeight - target.scroller.clientHeight),
    );

    this.applyScroll(target, desiredScrollTop);

    // CodeMirror may update estimated block heights after the first scroll.
    // Correct once on the next frame using the actual target block position.
    window.requestAnimationFrame(() => {
      if (!this.active || !this.pair) return;
      const actualTargetBlock = getLineBlock(target, anchor.line);
      if (!actualTargetBlock) return;
      const corrected = clamp(
        actualTargetBlock.top - anchor.viewportTop,
        0,
        Math.max(
          0,
          target.scroller.scrollHeight - target.scroller.clientHeight,
        ),
      );
      if (Math.abs(target.scroller.scrollTop - corrected) > 1) {
        this.applyScroll(target, corrected);
      }
    });
  }

  scheduleIdleAlignment(pair, source = null, target = null) {
    if (!pair || !this.active || this.pair !== pair) return;

    if (source) pair.alignmentSource = source;
    if (target) pair.alignmentTarget = target;

    if (pair.alignmentIdleTimer != null) {
      window.clearTimeout(pair.alignmentIdleTimer);
    }
    if (pair.alignmentRefreshTimer != null) {
      window.clearTimeout(pair.alignmentRefreshTimer);
      pair.alignmentRefreshTimer = null;
    }

    pair.alignmentIdleTimer = window.setTimeout(() => {
      pair.alignmentIdleTimer = null;
      if (!this.active || this.pair !== pair) return;

      const refreshSource =
        pair.alignmentSource ||
        this.lastSource ||
        (this.app.workspace.getActiveViewOfType(MarkdownView) ===
        pair.right.view
          ? pair.right
          : pair.left);
      const refreshTarget =
        pair.alignmentTarget ||
        (refreshSource === pair.left ? pair.right : pair.left);
      pair.alignmentSource = null;
      pair.alignmentTarget = null;
      this.scheduleGapAlignment(pair, refreshSource, refreshTarget, true);

      // Live Preview can finish virtualizing/rendering the newly visible
      // lines after the first idle frame. Take one later measurement, but do
      // not keep observing DOM mutations during a scroll gesture.
      pair.alignmentRefreshTimer = window.setTimeout(() => {
        pair.alignmentRefreshTimer = null;
        if (!this.active || this.pair !== pair) return;
        this.scheduleGapAlignment(pair, refreshSource, refreshTarget, true);
      }, 550);
    }, 180);
  }

  scheduleGapAlignment(pair, source = null, target = null, realignAfter = false) {
    if (!pair || !this.active || this.pair !== pair) return;

    if (source) pair.alignmentSource = source;
    if (target) pair.alignmentTarget = target;
    pair.realignAfter = pair.realignAfter || realignAfter;

    if (pair.alignmentFrame != null) return;

    pair.alignmentFrame = window.requestAnimationFrame(() => {
      pair.alignmentFrame = null;
      if (!this.active || this.pair !== pair) return;

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selectedSource =
        pair.alignmentSource ||
        this.lastSource ||
        (activeView === pair.right.view ? pair.right : pair.left);
      const selectedTarget =
        pair.alignmentTarget ||
        (selectedSource === pair.left ? pair.right : pair.left);
      const shouldRealign = pair.realignAfter;
      pair.alignmentSource = null;
      pair.alignmentTarget = null;
      pair.realignAfter = false;

      const changed = rebuildLineGaps(selectedSource, selectedTarget);

      if (changed || shouldRealign) {
        pair.isApplyingLayout = true;
        if (changed) {
          applyVisibleGaps(selectedSource);
          applyVisibleGaps(selectedTarget);
        }
        if (shouldRealign) {
          this.syncFrom(selectedSource, selectedTarget);
        }
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (this.pair !== pair) return;
            pair.isApplyingLayout = false;
            pair.left.lastScrollTop = pair.left.scroller.scrollTop;
            pair.right.lastScrollTop = pair.right.scroller.scrollTop;
          });
        });
      }
    });
  }

  applyScroll(target, scrollTop) {
    target.pendingTarget = scrollTop;
    target.lastScrollTop = scrollTop;
    target.isProgrammatic = true;
    target.scroller.scrollTop = scrollTop;

    window.requestAnimationFrame(() => {
      target.isProgrammatic = false;
    });
  }
}

class PreciseLineSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Precise Line Sync" });

    new Setting(containerEl)
      .setName("Enable line alignment")
      .setDesc(
        "Keep corresponding logical lines aligned in two side-by-side Live Preview notes.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.active).onChange(async (value) => {
          await this.plugin.setEnabled(value);
          toggle.setValue(this.plugin.active);
        }),
      );

    new Setting(containerEl)
      .setName("Alignment probe position")
      .setDesc(
        "The vertical position used to decide which logical line is currently being read. A small value avoids unstable line changes at the very top of the viewport.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 120, 4)
          .setValue(this.plugin.settings.anchorOffset)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.anchorOffset = value;
            await this.plugin.saveData(this.plugin.settings);
            if (this.plugin.pair) {
              this.plugin.scheduleGapAlignment(this.plugin.pair, null, null, true);
            }
          }),
      );

    containerEl.createEl("p", {
      text: "Use the Command Palette to enable, disable, or toggle synchronization. The plugin maps line 1 to line 1, line 2 to line 2, and so on; it does not try to match character positions.",
      cls: "setting-item-description",
    });
  }
}

function findHorizontalPair(workspace) {
  const visible = workspace
    .getLeavesOfType("markdown")
    .map((leaf) => ({ leaf, view: leaf.view }))
    .filter(({ view }) => {
      if (!(view instanceof MarkdownView)) return false;
      const rect = view.containerEl.getBoundingClientRect();
      return (
        rect.width > 40 &&
        rect.height > 40 &&
        view.contentEl?.querySelector(".cm-scroller")
      );
    });

  if (visible.length < 2) return null;

  const activeView = workspace.getActiveViewOfType(MarkdownView);
  const candidates = [];

  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i];
      const b = visible[j];
      const ar = a.view.containerEl.getBoundingClientRect();
      const br = b.view.containerEl.getBoundingClientRect();

      const verticalOverlap =
        Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top));
      const minimumHeight = Math.min(ar.height, br.height);
      const verticalRatio = minimumHeight
        ? verticalOverlap / minimumHeight
        : 0;
      const sideBySide = ar.right <= br.left + 24 || br.right <= ar.left + 24;

      if (!sideBySide || verticalRatio < 0.5) continue;

      const activeBonus =
        a.view === activeView || b.view === activeView ? 10000 : 0;
      const distance = Math.abs(ar.left - br.left);
      candidates.push({ a, b, score: activeBonus + verticalRatio * 1000 - distance });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);

  const chosen = candidates[0];
  const firstRect = chosen.a.view.containerEl.getBoundingClientRect();
  const secondRect = chosen.b.view.containerEl.getBoundingClientRect();
  const left = firstRect.left <= secondRect.left ? chosen.a : chosen.b;
  const right = left === chosen.a ? chosen.b : chosen.a;

  return {
    left: makePane(left),
    right: makePane(right),
    alignmentFrame: null,
    alignmentIdleTimer: null,
    alignmentSource: null,
    alignmentTarget: null,
    alignmentRefreshTimer: null,
    realignAfter: false,
    isApplyingLayout: false,
  };
}

function makePane(item) {
  return {
    leaf: item.leaf,
    view: item.view,
    editor: item.view.editor,
    scroller: item.view.contentEl.querySelector(".cm-scroller"),
    pendingTarget: null,
    isProgrammatic: false,
    lastScrollTop: item.view.contentEl.querySelector(".cm-scroller")?.scrollTop || 0,
    gaps: new Map(),
    naturalHeights: new Map(),
    appliedGapSignature: null,
    nativeExtensionAttached: false,
  };
}

function sameViewPair(oldPair, newPair) {
  if (!oldPair || !newPair) return oldPair === newPair;
  return (
    oldPair.left.view === newPair.left.view &&
    oldPair.right.view === newPair.right.view
  );
}

function samePair(oldPair, newPair) {
  if (!oldPair || !newPair) return oldPair === newPair;
  return (
    sameViewPair(oldPair, newPair) &&
    oldPair.left.scroller === newPair.left.scroller &&
    oldPair.right.scroller === newPair.right.scroller
  );
}

function rebuildLineGaps(source, target) {
  const sourceCm = getCodeMirror(source);
  const targetCm = getCodeMirror(target);
  if (!sourceCm?.state?.doc || !targetCm?.state?.doc) return false;

  const commonLineCount = Math.min(
    sourceCm.state.doc.lines,
    targetCm.state.doc.lines,
  );
  if (commonLineCount < 1) return false;

  let sourceHeight = 0;
  let targetHeight = 0;
  const sourceGaps = new Map();
  const targetGaps = new Map();

  // Rebuild from line 1 so newly measured lines cannot invalidate the
  // cumulative alignment established for earlier lines.
  for (let line = 0; line < commonLineCount; line += 1) {
    const sourceLineHeight = getNaturalLineHeight(source, line);
    const targetLineHeight = getNaturalLineHeight(target, line);
    if (sourceLineHeight == null || targetLineHeight == null) return false;

    sourceHeight += sourceLineHeight;
    targetHeight += targetLineHeight;
    const difference = targetHeight - sourceHeight;

    if (difference > 0.5) {
      sourceGaps.set(line, difference);
      sourceHeight += difference;
    } else if (difference < -0.5) {
      targetGaps.set(line, -difference);
      targetHeight += -difference;
    }
  }

  const sourceChanged = replaceAllGaps(source, sourceGaps);
  const targetChanged = replaceAllGaps(target, targetGaps);
  return sourceChanged || targetChanged;
}

function getNaturalLineHeight(pane, lineNumber) {
  const cm = getCodeMirror(pane);
  if (!cm?.state?.doc) return null;

  const current = getLineStartGeometry(pane, lineNumber);
  const next =
    lineNumber + 1 < cm.state.doc.lines
      ? getLineStartGeometry(pane, lineNumber + 1)
      : null;
  const currentGap = pane.gaps.get(lineNumber) || 0;

  // Position coordinates follow the actual Live Preview rendering, including
  // wrapped content and block widgets. Remove only this plugin's existing
  // spacer when deriving the natural source-line height.
  if (current && next) {
    const measured = next.top - current.top - currentGap;
    if (Number.isFinite(measured) && measured > 0) {
      const natural = Math.max(1, measured);
      pane.naturalHeights.set(lineNumber, natural);
      return natural;
    }
  }

  if (pane.naturalHeights.has(lineNumber)) {
    return pane.naturalHeights.get(lineNumber);
  }

  try {
    const line = cm.state.doc.line(lineNumber + 1);
    const block = cm.lineBlockAt?.(line.from);
    if (block && Number.isFinite(block.height)) {
      const natural = Math.max(1, Number(block.height) - currentGap);
      pane.naturalHeights.set(lineNumber, natural);
      return natural;
    }
  } catch (_error) {
    // Use the default line height below.
  }

  return Number(cm.defaultLineHeight) || 20;
}

function replaceAllGaps(pane, newGaps) {
  if (pane.gaps.size === newGaps.size) {
    let identical = true;
    for (const [line, gap] of newGaps) {
      if (Math.abs((pane.gaps.get(line) || 0) - gap) > 0.5) {
        identical = false;
        break;
      }
    }
    if (identical) return false;
  }

  pane.gaps = new Map(newGaps);
  return true;
}

function attachRuntimeLineGapField(cm) {
  if (!cm?.state?.doc || !ensureRuntimeLineGapExtension(cm)) return false;
  if (cm.state.field(runtimeLineGapField, false)) return true;
  try {
    cm.dispatch({
      effects: runtimeStateEffect.appendConfig.of(runtimeLineGapField),
    });
    return Boolean(cm.state.field(runtimeLineGapField, false));
  } catch (_error) {
    return false;
  }
}

function applyVisibleGaps(pane) {
  const cm = getCodeMirror(pane);
  if (!cm?.state?.doc || !attachRuntimeLineGapField(cm)) return;

  const gaps = Array.from(pane.gaps.entries())
    .filter(([, gap]) => gap > 0.5)
    .map(([line, gap]) => ({ line, gap }))
    .sort((a, b) => a.line - b.line);
  const signature = JSON.stringify(gaps);
  if (signature === pane.appliedGapSignature) return;

  if (!runtimeLineGapEffect) return;
  cm.dispatch({ effects: runtimeLineGapEffect.of(gaps) });
  pane.appliedGapSignature = signature;
}

function clearPaneGaps(pane) {
  if (!pane) return;
  pane.gaps.clear();
  pane.appliedGapSignature = null;
  applyVisibleGaps(pane);
}

function getCodeMirror(pane) {
  return pane.view?.editor?.cm || null;
}

function getLineAnchor(pane, anchorOffset) {
  const cm = getCodeMirror(pane);
  if (!cm?.state?.doc) return null;

  const scrollerRect = pane.scroller.getBoundingClientRect();
  const targetY = scrollerRect.top + Number(anchorOffset || 0);
  let chosen = null;

  // In Live Preview, DOM .cm-line elements are not a reliable one-to-one
  // mapping to source lines. CodeMirror's position coordinates are.
  for (let line = 0; line < cm.state.doc.lines; line += 1) {
    const from = cm.state.doc.line(line + 1).from;
    const coords = cm.coordsAtPos?.(from);
    if (!coords || !Number.isFinite(coords.top)) continue;
    if (coords.top <= targetY) {
      chosen = { line, top: coords.top };
    } else if (chosen) {
      break;
    }
  }

  if (!chosen) {
    const first = cm.coordsAtPos?.(cm.state.doc.line(1).from);
    if (!first) return null;
    chosen = { line: 0, top: first.top };
  }

  return {
    line: chosen.line,
    viewportTop: chosen.top - scrollerRect.top,
  };
}

function getLineStartGeometry(pane, lineNumber) {
  const cm = getCodeMirror(pane);
  if (!cm?.state?.doc) return null;
  const safeLine = clamp(
    Math.floor(lineNumber),
    0,
    Math.max(0, cm.state.doc.lines - 1),
  );
  const line = cm.state.doc.line(safeLine + 1);
  const coords = cm.coordsAtPos?.(line.from);
  if (!coords || !Number.isFinite(coords.top)) return null;

  const scrollerRect = pane.scroller.getBoundingClientRect();
  return {
    top: pane.scroller.scrollTop + coords.top - scrollerRect.top,
    viewportTop: coords.top - scrollerRect.top,
    from: line.from,
  };
}

function getLineBlock(pane, lineNumber) {
  const cm = getCodeMirror(pane);
  if (!cm?.state?.doc) return null;

  const geometry = getLineStartGeometry(pane, lineNumber);
  if (geometry) {
    const natural = getNaturalLineHeight(pane, lineNumber);
    return {
      top: geometry.top,
      height: natural == null
        ? Number(cm.defaultLineHeight) || 20
        : natural + (pane.gaps.get(lineNumber) || 0),
      from: geometry.from,
    };
  }

  try {
    const safeLine = clamp(
      Math.floor(lineNumber),
      0,
      Math.max(0, cm.state.doc.lines - 1),
    );
    const line = cm.state.doc.line(safeLine + 1);
    if (typeof cm.lineBlockAt === "function") {
      const block = cm.lineBlockAt(line.from);
      if (block && Number.isFinite(block.top)) return block;
    }
  } catch (_error) {
    // Fall through to the DOM implementation.
  }

  return getDomLineBlock(pane, lineNumber);
}

function getDomLineAnchor(pane, anchorOffset) {
  const lines = Array.from(pane.scroller.querySelectorAll(".cm-line"));
  if (!lines.length) return null;

  const targetY = pane.scroller.getBoundingClientRect().top + anchorOffset;
  let chosen = lines[0];
  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    if (rect.top <= targetY && rect.bottom >= targetY) {
      chosen = line;
      break;
    }
    if (rect.top <= targetY) chosen = line;
  }

  const number = getElementLineNumber(pane, chosen);
  if (number == null) return null;
  const rect = chosen.getBoundingClientRect();
  return {
    line: number,
    viewportTop: rect.top - pane.scroller.getBoundingClientRect().top,
  };
}

function getDomLineBlock(pane, lineNumber) {
  const line = findVisibleLineElement(pane, lineNumber);
  if (!line) return null;

  const scrollerRect = pane.scroller.getBoundingClientRect();
  const rect = line.getBoundingClientRect();
  return {
    top: rect.top - scrollerRect.top + pane.scroller.scrollTop,
    height: rect.height,
    from: lineNumber,
  };
}

function findVisibleLineElements(pane, lineNumber) {
  return Array.from(pane.scroller.querySelectorAll(".cm-line")).filter(
    (element) => getElementLineNumber(pane, element) === lineNumber,
  );
}

function findVisibleLineElement(pane, lineNumber) {
  return findVisibleLineElements(pane, lineNumber)[0] || null;
}

function getLineDataInfo(pane) {
  const element = pane.scroller.querySelector(
    ".cm-line[data-line], .cm-line[data-line-number]",
  );
  if (!element) return null;

  const attribute = element.hasAttribute("data-line")
    ? "data-line"
    : "data-line-number";
  const raw = Number(element.getAttribute(attribute));
  if (!Number.isFinite(raw)) return null;

  const logicalLine = getElementLineNumberFromPosition(pane, element);
  return {
    attribute,
    // Obsidian versions have used both zero-based and one-based DOM values.
    // Derive the offset from the actual CodeMirror position instead of
    // assuming one convention.
    offset: logicalLine == null ? 0 : raw - logicalLine,
  };
}

function getElementLineNumberFromPosition(pane, element) {
  const cm = getCodeMirror(pane);
  if (!cm?.state?.doc) return null;

  try {
    const rect = element.getBoundingClientRect();
    const pos = cm.posAtCoords?.({
      x: rect.left + 4,
      y: rect.top + 1,
    });
    if (typeof pos === "number") {
      return cm.state.doc.lineAt(pos).number - 1;
    }

    if (typeof cm.lineBlockAtHeight === "function") {
      const scrollerRect = pane.scroller.getBoundingClientRect();
      const height = pane.scroller.scrollTop + rect.top - scrollerRect.top + 1;
      const block = cm.lineBlockAtHeight(height);
      return cm.state.doc.lineAt(block.from).number - 1;
    }
  } catch (_error) {
    // The line may have been virtualized between the DOM lookup and the
    // CodeMirror lookup. It will be picked up on the next mutation pass.
  }
  return null;
}

function getElementLineNumber(pane, element) {
  return (
    getElementLineNumberFromPosition(pane, element) ??
    readLineAttributeNumber(element)
  );
}

function readLineAttributeNumber(element) {
  const raw =
    element.getAttribute("data-line") ||
    element.getAttribute("data-line-number") ||
    element.dataset?.line;
  return raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
}

function escapeCssNumber(value) {
  return String(Math.max(0, Math.floor(Number(value) || 0)));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

module.exports = { default: PreciseLineSyncPlugin };
