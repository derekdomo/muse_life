// CMP-READ-001 P1 validation — the Reader's explicit version
// switch: a cached old-version response must not re-pin the old
// version mid-switch, a post-switch chapter must not restore the
// pre-switch offsets, and a held selection must save against the
// chapter it was captured in — never the requested chapter.
// Failure-recovery remainder: a failed chapter-0 target request
// must land in an honest switch-failed phase (display + draft
// kept, writes still blocked, same-target retry), the version
// check must never claim 已是最新版本 under an unset pin, and
// non-target responses / navigation must never complete the
// switch ahead of the chapter-0 target.
//
// Two layers:
//  1. Source wiring: Reader.tsx routes admission / restore /
//     capture / save through the exported pure functions, the
//     switch handler records the pre-switch pin and sets the
//     awaiting marker, and the scroll save names the DISPLAYED
//     snapshot's chapter (via its ref mirror), not chapterIdx.
//  2. Behavior: the REAL exported functions from
//     client/src/Reader.tsx drive a simulation that mirrors the
//     component's own wiring (pin ref, switch refs, generation,
//     snapshot, selection) through the two response orderings,
//     the write blocks, and the failure paths. Mutation
//     sensitivity is proven at the end: the same fixtures run
//     against pre-fix decision shapes (no awaiting guard; payload
//     built from the requested chapter) MUST fail.
//
// Client logic only; no server code is touched or re-tested here
// (validate-import-generations / validate-reading-qa /
// validate-save-atomicity cover the server suites unchanged).
// Run with: bun validate-reader-switch.mjs
import { readFileSync } from "node:fs";

let passed = 0;
let failures = 0;
function check(name, ok, note = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${note ? ` (${note})` : ""}`);
}

/* ---------------- 1. source wiring ---------------- */

const readerSrc = readFileSync(new URL("./client/src/Reader.tsx", import.meta.url), "utf8");

const {
  admitChapterResponse,
  restoreTargetOffset,
  captureSelectionBinding,
  snippetSavePayload,
  readerWritesBlocked,
  resolveSwitchPhase,
  resolveVersionCheck,
} = await import("./client/src/Reader.tsx");

check(
  "source: Reader exports the pure decisions (admission / restore / capture / payload / write gate / switch phase / version check)",
  [
    admitChapterResponse,
    restoreTargetOffset,
    captureSelectionBinding,
    snippetSavePayload,
    readerWritesBlocked,
    resolveSwitchPhase,
    resolveVersionCheck,
  ].every((f) => typeof f === "function"),
);
check(
  "source: admission decision refuses old-version responses while awaiting (switchFromVersion comparison)",
  readerSrc.includes("state.awaitingNewVersion") &&
    readerSrc.includes("data.liveVersion === (state.switchFromVersion ?? null)"),
);
check(
  "source: the switch handler records the pre-switch pin and sets the awaiting marker + generation",
  readerSrc.includes("switchFromRef.current = pinnedVersionRef.current") &&
    readerSrc.includes("awaitingRef.current = true") &&
    readerSrc.includes("generationRef.current += 1"),
);
check(
  "source: admission effect delegates to admitChapterResponse with the pin/switch refs",
  readerSrc.includes("admitChapterResponse(") &&
    readerSrc.includes("switchFromVersion: switchFromRef.current"),
);
check(
  "source: restore effect delegates to restoreTargetOffset keyed on the snapshot generation",
  readerSrc.includes("restoreTargetOffset({") &&
    readerSrc.includes("generation: snapshot.generation"),
);
{
  const saveSlice = readerSrc.slice(
    readerSrc.indexOf("const saveSnippet"),
    readerSrc.indexOf("const toc ="),
  );
  check(
    "source: saveSnippet payload comes only from snippetSavePayload (no requested chapterIdx / live ref splice)",
    saveSlice.includes("snippetSavePayload(book.id, snippetKeyRef.current, sel)") &&
      !saveSlice.includes("chapterIdx,") &&
      !saveSlice.includes("pinnedVersionRef"),
  );
}
{
  const scrollSlice = readerSrc.slice(
    readerSrc.indexOf("Persist position as the owner scrolls"),
    readerSrc.indexOf("const captureSelection"),
  );
  check(
    "source: scroll position save names the DISPLAYED snapshot chapter via its ref mirror, gated by readerWritesBlocked",
    scrollSlice.includes("snapshotRef.current") &&
      scrollSlice.includes("chapterIdx: snap.idx") &&
      scrollSlice.includes("readerWritesBlocked({"),
  );
}
check(
  "source: capture binds via captureSelectionBinding against the snapshot ref mirror",
  readerSrc.includes("captureSelectionBinding(") &&
    readerSrc.includes("snapshotRef.current,"),
);
check(
  "source: the reader shows a switching state while awaiting (display kept, loading stated)",
  readerSrc.includes("正在加载新版本"),
);
check(
  "source: admission carries the switch target and refuses non-target responses while awaiting",
  readerSrc.includes("requestedIdx !== (state.switchTargetIdx ?? 0)") &&
    readerSrc.includes("switchTargetIdx: switchTargetRef.current") &&
    readerSrc.includes("switchTargetRef.current = 0"),
);
check(
  "source: a settled target-request failure (query error or forbidden response) is recorded while awaiting, fetch-in-flight excluded",
  readerSrc.includes("if (!awaitingRef.current || chapter.isFetching) return;") &&
    readerSrc.includes("chapter.isError || chapter.data?.forbidden === true") &&
    readerSrc.includes("setSwitchFailed(true)"),
);
{
  const retrySlice = readerSrc.slice(
    readerSrc.indexOf("const retrySwitch"),
    readerSrc.indexOf("const checkVersion"),
  );
  check(
    "source: retry re-issues ONLY the switch-target chapter query — same switchFrom / generation / target, pin never restored",
    retrySlice.includes('queryKey: ["chapter", book.id, switchTargetRef.current]') &&
      retrySlice.includes("invalidateQueries") &&
      !retrySlice.includes("generationRef") &&
      !retrySlice.includes("switchFromRef") &&
      !retrySlice.includes("pinnedVersionRef"),
  );
}
check(
  "source: the failed phase renders an honest failure notice with a 重试切换 entry, gated on the phase (not on switching alone)",
  readerSrc.includes('switchPhase === "switch-failed"') &&
    readerSrc.includes("新版本切换失败") &&
    readerSrc.includes("重试切换") &&
    readerSrc.includes("onClick={retrySwitch}") &&
    readerSrc.includes("resolveSwitchPhase({"),
);
{
  const checkSlice = readerSrc.slice(
    readerSrc.indexOf("const checkVersion"),
    readerSrc.indexOf("const safeHtml"),
  );
  check(
    "source: checkVersion delegates to resolveVersionCheck and no longer treats an unset pin as 已是最新版本",
    checkSlice.includes("resolveVersionCheck({") &&
      checkSlice.includes("awaitingNewVersion: awaitingRef.current") &&
      !checkSlice.includes("=== undefined ||"),
  );
}
check(
  "source: TOC / previous / next navigation is disabled for the whole unresolved switch attempt (loading AND failed phases)",
  readerSrc.includes("disabled={versionStale || switching}") &&
    readerSrc.includes("disabled={versionStale || switching || chapterIdx <= 0}") &&
    readerSrc.includes("disabled={versionStale || switching || toc.length === 0"),
);
{
  const switchStart = readerSrc.indexOf("switchFromRef.current = pinnedVersionRef.current");
  const switchSlice = readerSrc.slice(
    switchStart,
    readerSrc.indexOf('queryKey: ["library"]', switchStart),
  );
  check(
    "source: starting a switch resets the failure ledger and KEEPS any held selection draft (no setSelection(null))",
    switchSlice.includes("setSwitchFailed(false)") && !switchSlice.includes("setSelection(null)"),
  );
}

/* ---------------- 2. behavior: real functions ---------------- */

// A getChapter-shaped response for version `v`, chapter `idx`.
function resp(v, idx) {
  return {
    forbidden: false,
    found: true,
    title: `第 ${idx} 章 · ${v} 版`,
    html: `<p>${v} 版第 ${idx} 章正文</p>`,
    toc: [0, 1, 2].map((i) => ({ idx: i, title: `第 ${i} 章 · ${v} 版` })),
    liveVersion: v,
    versionLabel: `${v} 版`,
  };
}
const FORBIDDEN = {
  forbidden: true,
  found: false,
  title: null,
  html: "",
  toc: [],
  liveVersion: null,
  versionLabel: null,
};

// A simulation that mirrors the component's wiring exactly: the
// admission effect, the switch handler, and the write gate all
// run through the same exported functions the component calls.
function makeReaderSim() {
  return {
    pinned: undefined,
    switchFrom: undefined,
    awaiting: false,
    generation: 0,
    snapshot: null,
    staleRaised: false,
    switchTarget: 0,
    targetFailed: false,
    onResponse(requestedIdx, data) {
      const res = admitChapterResponse(
        {
          pinned: this.pinned,
          awaitingNewVersion: this.awaiting,
          switchFromVersion: this.switchFrom,
          switchTargetIdx: this.switchTarget,
        },
        requestedIdx,
        this.generation,
        data,
      );
      if (res.kind === "admit") {
        this.pinned = res.pinned;
        this.snapshot = res.snapshot;
        if (this.awaiting) {
          this.awaiting = false;
          this.targetFailed = false;
        }
      } else if (res.kind === "stale") {
        this.staleRaised = true;
      }
      return res;
    },
    switchToNewVersion() {
      this.switchFrom = this.pinned;
      this.awaiting = true;
      this.pinned = undefined;
      this.generation += 1;
      this.staleRaised = false;
      this.switchTarget = 0;
      this.targetFailed = false;
    },
    // Mirrors the component's failure effect: a settled
    // target-request failure (query error / forbidden response)
    // while awaiting moves ONLY the failure ledger.
    markTargetFailed() {
      if (this.awaiting) this.targetFailed = true;
    },
    // Mirrors retrySwitch: same switchFrom, same generation,
    // same chapter-0 target — only the request re-issues.
    retrySwitch() {
      this.targetFailed = false;
    },
    phase() {
      return resolveSwitchPhase({
        awaitingNewVersion: this.awaiting,
        targetFailed: this.targetFailed,
        switchCompleted: (this.snapshot?.generation ?? 0) > 0,
      });
    },
    writesBlocked() {
      return readerWritesBlocked({
        pinned: this.pinned,
        awaitingNewVersion: this.awaiting,
      });
    },
  };
}

/* --- A: cached old-version response returns FIRST --- */
{
  const sim = makeReaderSim();
  const first = sim.onResponse(2, resp("G", 2));
  check(
    "A setup: initial load at G chapter 2 admits and pins G (generation 0)",
    first.kind === "admit" && sim.pinned === "G" && sim.snapshot?.idx === 2 && sim.snapshot?.generation === 0,
  );
  sim.switchToNewVersion();
  check(
    "A: switch records switchFrom=G, sets awaiting, unsets the pin, advances the generation",
    sim.switchFrom === "G" && sim.awaiting === true && sim.pinned === undefined && sim.generation === 1,
  );
  check("A: writes are blocked while awaiting the new version", sim.writesBlocked() === true);
  const cached = sim.onResponse(0, resp("G", 0));
  check(
    "A: cached G chapter-0 response during the switch is IGNORED (no re-pin)",
    cached.kind === "ignore" && sim.pinned === undefined,
  );
  check(
    "A: the ignored cache echo leaves the display snapshot untouched (still G chapter 2, generation 0)",
    sim.snapshot?.idx === 2 && sim.snapshot?.liveVersion === "G" && sim.snapshot?.generation === 0,
  );
  const landed = sim.onResponse(0, resp("H", 0));
  check(
    "A: the first different-version response completes the switch (pins H, snapshot = H chapter 0, generation 1)",
    landed.kind === "admit" &&
      sim.pinned === "H" &&
      sim.awaiting === false &&
      sim.snapshot?.idx === 0 &&
      sim.snapshot?.liveVersion === "H" &&
      sim.snapshot?.generation === 1,
  );
  check(
    "A: no stale banner was raised by the completed switch, and writes unblock under the settled pin",
    sim.staleRaised === false && sim.writesBlocked() === false,
  );
}

/* --- B: new-version response returns FIRST + restore offsets --- */
{
  const sim = makeReaderSim();
  sim.onResponse(0, resp("G", 0));
  sim.switchToNewVersion();
  const landed = sim.onResponse(0, resp("H", 0));
  check(
    "B: when H returns first it is admitted immediately (pin H, awaiting cleared)",
    landed.kind === "admit" && sim.pinned === "H" && sim.awaiting === false,
  );
  check(
    "B: post-switch restore target is 0 even with old startOffset=42 on the same chapter",
    restoreTargetOffset({
      generation: sim.snapshot.generation,
      snapshotIdx: 0,
      startChapter: 0,
      startOffset: 42,
      bookChapter: 0,
      bookOffset: 42,
    }) === 0,
  );
  check(
    "B: post-switch restore target is 0 even with a nonzero saved book offset",
    restoreTargetOffset({
      generation: 1,
      snapshotIdx: 0,
      startChapter: undefined,
      startOffset: undefined,
      bookChapter: 0,
      bookOffset: 137,
    }) === 0,
  );
  check(
    "B: initial generation still honors startOffset on the start chapter",
    restoreTargetOffset({
      generation: 0,
      snapshotIdx: 0,
      startChapter: 0,
      startOffset: 42,
      bookChapter: 2,
      bookOffset: 9,
    }) === 42,
  );
  check(
    "B: initial generation still honors the book offset on the book's chapter",
    restoreTargetOffset({
      generation: 0,
      snapshotIdx: 2,
      startChapter: 0,
      startOffset: 42,
      bookChapter: 2,
      bookOffset: 9,
    }) === 9,
  );
  check(
    "B: initial generation restores 0 on any other chapter",
    restoreTargetOffset({
      generation: 0,
      snapshotIdx: 1,
      startChapter: 0,
      startOffset: 42,
      bookChapter: 2,
      bookOffset: 9,
    }) === 0,
  );
}

/* --- C: selection binding survives chapter requests/responses --- */
{
  const sim = makeReaderSim();
  sim.onResponse(0, resp("G", 0));
  const sel = captureSelectionBinding(sim.snapshot, "被选中的原文", 7);
  check(
    "C: capture freezes the displayed chapter's idx / title / pinned version",
    sel !== null &&
      sel.chapterIdx === 0 &&
      sel.chapterLabel === "第 0 章 · G 版" &&
      sel.liveVersion === "G" &&
      sel.charOffset === 7,
  );
  // The owner taps 下一章： requested chapter becomes 1, but no
  // response has landed — the display (and the held selection)
  // still belong to chapter 0.
  const payloadBefore = snippetSavePayload(5, "req-switch-1", sel);
  check(
    "C: save payload while chapter 1 is merely REQUESTED still names captured chapter 0",
    payloadBefore.chapterIdx === 0 &&
      payloadBefore.chapterLabel === "第 0 章 · G 版" &&
      payloadBefore.liveVersion === "G" &&
      payloadBefore.text === "被选中的原文",
  );
  // Chapter 1's response lands and replaces the snapshot; saving
  // the SAME held selection must still write the captured chapter.
  sim.onResponse(1, resp("G", 1));
  const payloadAfter = snippetSavePayload(5, "req-switch-1", sel);
  check(
    "C: save payload after chapter 1 lands is unchanged (capture-time binding wins)",
    sim.snapshot?.idx === 1 &&
      payloadAfter.chapterIdx === 0 &&
      payloadAfter.chapterLabel === "第 0 章 · G 版" &&
      payloadAfter.liveVersion === "G",
  );
  check(
    "C: no capture without a display snapshot (or from a chapter with no stored body)",
    captureSelectionBinding(null, "x", 0) === null &&
      captureSelectionBinding({ ...sim.snapshot, found: false }, "x", 0) === null,
  );
}

/* --- D: write gate, stale path, switch-failure preservation --- */
{
  check(
    "D: write gate — pin unset blocks, awaiting blocks, settled pin (incl. legacy null) allows",
    readerWritesBlocked({ pinned: undefined, awaitingNewVersion: false }) === true &&
      readerWritesBlocked({ pinned: undefined, awaitingNewVersion: true }) === true &&
      readerWritesBlocked({ pinned: "G", awaitingNewVersion: true }) === true &&
      readerWritesBlocked({ pinned: "G", awaitingNewVersion: false }) === false &&
      readerWritesBlocked({ pinned: null, awaitingNewVersion: false }) === false,
  );

  const stale = makeReaderSim();
  stale.onResponse(0, resp("G", 0));
  const before = stale.snapshot;
  const r = stale.onResponse(1, resp("H", 1));
  check(
    "D: a different version outside a switch is stale-only (pin and snapshot untouched)",
    r.kind === "stale" && stale.pinned === "G" && stale.snapshot === before && stale.staleRaised === true,
  );

  const guest = makeReaderSim();
  const g = guest.onResponse(0, FORBIDDEN);
  check(
    "D: a forbidden first response pins nothing and shows nothing",
    g.kind === "skip" && guest.pinned === undefined && guest.snapshot === null,
  );

  const failing = makeReaderSim();
  failing.onResponse(0, resp("G", 0));
  const heldSel = captureSelectionBinding(failing.snapshot, "切换前选好的句子", 3);
  const heldSnapshot = failing.snapshot;
  failing.switchToNewVersion();
  const noData = failing.onResponse(0, undefined);
  const forb = failing.onResponse(0, FORBIDDEN);
  check(
    "D: switch with no / forbidden response keeps the old display and the held selection draft",
    noData.kind === "skip" &&
      forb.kind === "skip" &&
      failing.snapshot === heldSnapshot &&
      failing.awaiting === true &&
      snippetSavePayload(5, "req-switch-2", heldSel).chapterIdx === 0,
  );
  check(
    "D: writes stay blocked for the whole failed switch (position + snippet)",
    failing.writesBlocked() === true,
  );
}

/* --- E: mutation sensitivity --- */
{
  // Pre-fix admission shape: no awaiting concept — an unset pin
  // admits (and pins) the FIRST response, whatever its version.
  function admitMutant(state, requestedIdx, generation, data) {
    if (!data || data.forbidden) return { kind: "skip" };
    if (state.pinned === undefined || data.liveVersion === (state.pinned ?? null)) {
      return {
        kind: "admit",
        pinned: data.liveVersion,
        snapshot: {
          idx: requestedIdx,
          found: data.found,
          title: data.title,
          html: data.html,
          toc: data.toc,
          liveVersion: data.liveVersion,
          versionLabel: data.versionLabel,
          generation,
        },
      };
    }
    return { kind: "stale" };
  }
  const mutant = { pinned: "G", snapshot: null, staleRaised: false };
  const runMutant = (idx, data) => {
    const res = admitMutant({ pinned: mutant.pinned }, idx, 1, data);
    if (res.kind === "admit") {
      mutant.pinned = res.pinned;
      mutant.snapshot = res.snapshot;
    } else if (res.kind === "stale") {
      mutant.staleRaised = true;
    }
    return res;
  };
  // The old switch: clear the pin, request chapter 0.
  mutant.pinned = undefined;
  runMutant(0, resp("G", 0)); // cached old version returns first
  runMutant(0, resp("H", 0)); // the real new version
  check(
    "E: WITHOUT the awaiting guard the A fixture flips (cache re-pins G, H reads stale, switch fails)",
    mutant.pinned === "G" && mutant.staleRaised === true,
  );

  const sel = captureSelectionBinding(
    {
      idx: 0,
      found: true,
      title: "第 0 章 · G 版",
      html: "<p>x</p>",
      toc: [],
      liveVersion: "G",
      versionLabel: "G 版",
      generation: 0,
    },
    "被选中的原文",
    7,
  );
  const requestedChapterIdx = 1; // 下一章 was tapped; no response yet
  const mutantPayload = { ...snippetSavePayload(5, "req-mutant", sel), chapterIdx: requestedChapterIdx };
  check(
    "E: a payload built from the REQUESTED chapter flips the C fixture (chapterIdx 1 ≠ captured 0)",
    mutantPayload.chapterIdx === 1 && snippetSavePayload(5, "req-mutant", sel).chapterIdx === 0,
  );
}

/* --- F: target chapter-0 request fails → honest failed phase + same-target retry --- */
{
  const sim = makeReaderSim();
  sim.onResponse(2, resp("G", 2));
  const heldSel = captureSelectionBinding(sim.snapshot, "切换前选好的句子", 3);
  const heldSnapshot = sim.snapshot;
  sim.switchToNewVersion();
  check(
    "F: phase is switching while the target chapter-0 request is in flight",
    sim.phase() === "switching",
  );
  // The target request REJECTS (query error): no data arrives.
  const noData = sim.onResponse(0, undefined);
  sim.markTargetFailed();
  check(
    "F: a rejected target request lands in switch-failed — the attempt is not stuck at switching forever",
    noData.kind === "skip" && sim.phase() === "switch-failed" && sim.awaiting === true && sim.pinned === undefined,
  );
  check(
    "F: the failed switch keeps the current display (G chapter 2) and the held selection draft (bound to G chapter 2)",
    sim.snapshot === heldSnapshot &&
      sim.snapshot?.liveVersion === "G" &&
      snippetSavePayload(5, "req-f1", heldSel).chapterIdx === 2 &&
      snippetSavePayload(5, "req-f1", heldSel).liveVersion === "G",
  );
  check(
    "F: writes stay blocked for the whole failed phase",
    sim.writesBlocked() === true,
  );
  // A forbidden target response is a failure too, not a completion.
  sim.retrySwitch();
  const forb = sim.onResponse(0, FORBIDDEN);
  sim.markTargetFailed();
  check(
    "F: a forbidden target response also lands in switch-failed (pin still unset, display untouched)",
    forb.kind === "skip" && sim.phase() === "switch-failed" && sim.pinned === undefined && sim.snapshot === heldSnapshot,
  );
  const genBefore = sim.generation;
  const fromBefore = sim.switchFrom;
  sim.retrySwitch();
  check(
    "F: retry keeps the SAME switchFromVersion, generation and chapter-0 target, and returns the phase to switching",
    sim.phase() === "switching" &&
      sim.generation === genBefore &&
      sim.switchFrom === fromBefore &&
      sim.switchTarget === 0 &&
      sim.pinned === undefined,
  );
  const landed = sim.onResponse(0, resp("H", 0));
  check(
    "F: the retried chapter-0 response completes the switch (phase switch-done, pin H, snapshot H chapter 0, writes unblocked)",
    landed.kind === "admit" &&
      sim.phase() === "switch-done" &&
      sim.pinned === "H" &&
      sim.snapshot?.idx === 0 &&
      sim.snapshot?.liveVersion === "H" &&
      sim.writesBlocked() === false,
  );
}

/* --- G: navigation cannot preempt the switch; post-switch navigation + capture still work --- */
{
  const sim = makeReaderSim();
  sim.onResponse(0, resp("G", 0));
  sim.switchToNewVersion();
  // H chapter 1 lands BEFORE the H chapter-0 target (e.g. a
  // stray navigation request raced the switch): it must not
  // complete the switch or skip the owner's 从头 choice.
  const early = sim.onResponse(1, resp("H", 1));
  check(
    "G: a non-target chapter response during the switch is ignored — switch NOT completed, chapter 0 not skipped",
    early.kind === "ignore" &&
      sim.awaiting === true &&
      sim.pinned === undefined &&
      sim.snapshot?.idx === 0 &&
      sim.snapshot?.liveVersion === "G" &&
      sim.phase() === "switching",
  );
  const oldEcho = sim.onResponse(2, resp("G", 2));
  check(
    "G: a non-target old-version response during the switch is likewise ignored",
    oldEcho.kind === "ignore" && sim.awaiting === true && sim.phase() === "switching",
  );
  const target = sim.onResponse(0, resp("H", 0));
  check(
    "G: the target chapter-0 response then completes the switch",
    target.kind === "admit" && sim.pinned === "H" && sim.phase() === "switch-done",
  );
  const nav = sim.onResponse(1, resp("H", 1));
  const sel = captureSelectionBinding(sim.snapshot, "新版里的句子", 4);
  const payload = sel ? snippetSavePayload(5, "req-g1", sel) : null;
  check(
    "G: after the switch, normal navigation works and capture/payload bind the NEW version's chapter",
    nav.kind === "admit" &&
      sim.snapshot?.idx === 1 &&
      sel?.liveVersion === "H" &&
      payload?.chapterIdx === 1 &&
      payload?.liveVersion === "H" &&
      sim.writesBlocked() === false,
  );
}

/* --- H: version-check verdict honesty + the phase mapping itself --- */
{
  const base = { forbidden: false, found: true };
  const pending = resolveVersionCheck({ ...base, pinned: undefined, awaitingNewVersion: true, liveVersion: "H" });
  check(
    "H: pin unset with a switch unresolved → switch-pending, never 已是最新版本 (the G-body / unset-pin misreport)",
    pending.kind === "switch-pending" && pending.message !== "已是最新版本。" && pending.message.includes("尚未切换完成"),
  );
  const unsettled = resolveVersionCheck({ ...base, pinned: undefined, awaitingNewVersion: false, liveVersion: "G" });
  check(
    "H: pin unset outside a switch → unsettled, never 已是最新版本",
    unsettled.kind === "unsettled" && unsettled.message !== "已是最新版本。",
  );
  const current = resolveVersionCheck({ ...base, pinned: "G", awaitingNewVersion: false, liveVersion: "G" });
  check(
    "H: settled pin equal to the live version → current (已是最新版本） is the only path to that claim",
    current.kind === "current" && current.message === "已是最新版本。",
  );
  check(
    "H: settled pin behind the live version → stale",
    resolveVersionCheck({ ...base, pinned: "G", awaitingNewVersion: false, liveVersion: "H" }).kind === "stale",
  );
  check(
    "H: forbidden / not-found metadata → unknown, never current",
    resolveVersionCheck({ forbidden: true, found: false, pinned: undefined, awaitingNewVersion: false, liveVersion: null }).kind ===
      "unknown" &&
      resolveVersionCheck({ ...base, pinned: "G", awaitingNewVersion: false, liveVersion: "G" }).kind === "current",
  );
  check(
    "H: a legacy null pin equal to a null live version → current (unchanged legacy behavior)",
    resolveVersionCheck({ ...base, pinned: null, awaitingNewVersion: false, liveVersion: null }).kind === "current",
  );
  check(
    "H: resolveSwitchPhase maps idle / switching / switch-failed / switch-done exactly",
    resolveSwitchPhase({ awaitingNewVersion: false, targetFailed: false, switchCompleted: false }) === "idle" &&
      resolveSwitchPhase({ awaitingNewVersion: true, targetFailed: false, switchCompleted: false }) === "switching" &&
      resolveSwitchPhase({ awaitingNewVersion: true, targetFailed: true, switchCompleted: false }) === "switch-failed" &&
      resolveSwitchPhase({ awaitingNewVersion: false, targetFailed: false, switchCompleted: true }) === "switch-done" &&
      resolveSwitchPhase({ awaitingNewVersion: true, targetFailed: true, switchCompleted: true }) === "switch-failed",
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
