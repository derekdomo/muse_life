// CMP-READ-001 P1 validation — the Reader's explicit version
// switch: a cached old-version response must not re-pin the old
// version mid-switch, a post-switch chapter must not restore the
// pre-switch offsets, and a held selection must save against the
// chapter it was captured in — never the requested chapter.
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
} = await import("./client/src/Reader.tsx");

check(
  "source: Reader exports the pure decisions (admission / restore / capture / payload / write gate)",
  [admitChapterResponse, restoreTargetOffset, captureSelectionBinding, snippetSavePayload, readerWritesBlocked].every(
    (f) => typeof f === "function",
  ),
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
    onResponse(requestedIdx, data) {
      const res = admitChapterResponse(
        {
          pinned: this.pinned,
          awaitingNewVersion: this.awaiting,
          switchFromVersion: this.switchFrom,
        },
        requestedIdx,
        this.generation,
        data,
      );
      if (res.kind === "admit") {
        this.pinned = res.pinned;
        this.snapshot = res.snapshot;
        if (this.awaiting) this.awaiting = false;
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

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
