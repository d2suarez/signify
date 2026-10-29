import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { normalizePrefs, prefsAttrs, DEFAULT_PREFS } from "../src/lib/prefs";
import { getPrefs, savePrefs } from "../src/lib/prefs-store";
import { speechChunks, MAX_CHUNK } from "../src/lib/read-aloud";
import { normalizeBlocks, newBlock, blockSpeech, forStudent, BLOCK_TYPES } from "../src/lib/blocks";
import { boardLink } from "../src/lib/boards";
import { choose, turnsLeft } from "../src/lib/picker";
import { rmsToLevel, noiseWord, noiseColour, smooth } from "../src/lib/noise";
import { dict } from "../src/lib/i18n";

let db: Db;
before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

// ---------- reading supports ----------

test("prefs: unknown keys dropped, unknown values back to the default", () => {
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs("nope"), DEFAULT_PREFS);
  const p = normalizePrefs({ readAloud: "yes", rate: "warp", font: "dyslexia", size: "larger", spacing: "wide", contrast: "high", evil: "<script>" });
  assert.equal(p.readAloud, false, "only a real true turns read-aloud on");
  assert.equal(p.rate, "normal");
  assert.equal(p.font, "dyslexia");
  assert.equal(p.size, "larger");
  assert.equal(p.spacing, "wide");
  assert.equal(p.contrast, "high");
  assert.equal("evil" in p, false);
});

test("prefs: only non-default choices become attributes on <html>", () => {
  assert.deepEqual(prefsAttrs(DEFAULT_PREFS), {});
  assert.deepEqual(prefsAttrs({ ...DEFAULT_PREFS, readAloud: true, rate: "slow", contrast: "high" }),
    { "data-read-aloud": "on", "data-rate": "slow", "data-contrast": "high" });
});

test("prefs: saved per person within a school; another school's same id is someone else", async () => {
  const a = { tenantId: "school-a", userId: "student-1" };
  const b = { tenantId: "school-b", userId: "student-1" };
  assert.deepEqual(await getPrefs(a), DEFAULT_PREFS, "nothing saved means the defaults");
  await savePrefs(a, { readAloud: true, font: "dyslexia" });
  await savePrefs(a, { readAloud: true, font: "dyslexia", size: "large" }); // a second save replaces
  assert.equal((await getPrefs(a)).size, "large");
  assert.equal((await getPrefs(a)).readAloud, true);
  assert.deepEqual(await getPrefs(b), DEFAULT_PREFS);
  assert.deepEqual(await getPrefs({ tenantId: "school-a", userId: "student-2" }), DEFAULT_PREFS);
});

test("read-aloud: text goes out a sentence at a time, never longer than Chrome will say", () => {
  assert.deepEqual(speechChunks("One. Two!  Three?\nFour"), ["One.", "Two!", "Three?", "Four"]);
  assert.deepEqual(speechChunks("  \n\n "), []);
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  const parts = speechChunks(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= MAX_CHUNK));
  assert.equal(parts.join(" "), long, "nothing is lost when a long sentence is split");
  assert.ok(speechChunks("x".repeat(500)).every((p) => p.length <= MAX_CHUNK), "even with no spaces");
});

test("i18n: every new string has Spanish", () => {
  const en = dict("en");
  const es = dict("es");
  const keys = ["supports", "readAloud", "pause", "resume", "stop", "fontDyslexia", "textSize", "lineSpacing", "contrastHigh",
    "readMyWriting", "blockPicker", "blockNoise", "blockBoard", "pickYou", "pickSomeone", "micOn", "micOff", "noiseOver", "openBoard", "boardHint",
    "planner", "moveTo", "notScheduled", "pushBack", "planUnit", "plannerConflict", "cancel",
    "pacing", "paceTeacher", "paceReview", "paceSelf", "paceSelfNote", "goToTeacher", "slide", "projectorOpen", "projectorWaiting", "fullScreen"] as const;
  for (const k of keys) assert.notEqual(es[k], en[k], `${k} has no Spanish`);
});

// ---------- Desk tools and Boards as blocks ----------

test("blocks: every type has a new block that survives normalizing", () => {
  for (const type of BLOCK_TYPES) {
    const [b] = normalizeBlocks([newBlock(type)]);
    assert.equal(b.type, type);
  }
});

test("blocks: picker and noise settings are kept to what they can be", () => {
  const [p1, p2, n1, n2, n3] = normalizeBlocks([
    { type: "picker", label: " Who  reads? ", from: "class", repeat: "any" },
    { type: "picker", from: "everyone", repeat: 7 },
    { type: "noise", limit: 2 }, { type: "noise", limit: 500 }, { type: "noise", limit: "loud" },
  ]);
  assert.deepEqual(p1, { id: p1.id, type: "picker", label: "Who reads?", from: "class", repeat: "any" });
  assert.equal(p2.type === "picker" && `${p2.from}/${p2.repeat}`, "here/turns");
  assert.deepEqual([n1, n2, n3].map((b) => b.type === "noise" && b.limit), [10, 95, 55]);
});

test("boards: only Signify Boards links are kept; embeds are recognised", () => {
  assert.deepEqual(boardLink("https://draw.signify.one/embed/AbCdEfGh1234?x=1#y"), { url: "https://draw.signify.one/embed/AbCdEfGh1234", embed: true });
  assert.deepEqual(boardLink(" https://draw.signify.one/board.html?room=ABC123 "), { url: "https://draw.signify.one/board.html?room=ABC123", embed: false });
  assert.equal(boardLink("https://boards.signify.one/embed/zzzzzzzzzz")?.embed, true);
  for (const bad of ["https://evil.example/embed/AbCdEfGh1234", "http://draw.signify.one/embed/AbCdEfGh1234",
    "https://draw.signify.one.evil.example/embed/x", "javascript:alert(1)", "https://user:pw@draw.signify.one/", "", 42, null]) {
    assert.equal(boardLink(bad), null, String(bad));
  }
  const [kept, dropped] = normalizeBlocks([
    { type: "board", title: "Map", url: "https://draw.signify.one/embed/AbCdEfGh1234" },
    { type: "board", title: "Bad", url: "https://evil.example/" },
  ]);
  assert.equal(kept.type === "board" && kept.url, "https://draw.signify.one/embed/AbCdEfGh1234");
  assert.equal(dropped.type === "board" && dropped.url, "", "a foreign link is never stored, so never framed");
});

test("blocks: read-aloud text says the words on the slide, choices lettered", () => {
  assert.equal(blockSpeech({ id: "a", type: "text", title: "Cells", body: "All living things." }), "Cells.\nAll living things.");
  const [poll] = normalizeBlocks([{ type: "poll", question: "Pick", choices: [{ text: "Yes", correct: true }, { text: "No" }] }]);
  assert.equal(blockSpeech(forStudent(poll)), "Pick\nA. Yes\nB. No");
});

test("picker: everyone once before anyone twice, then a new round", () => {
  const pool = [{ id: "a", name: "Ana" }, { id: "b", name: "Ben" }, { id: "c", name: "Cy" }, { id: "a", name: "Ana" }];
  const picked: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = choose(pool, picked, "turns", Math.random());
    assert.equal(r.newRound, false);
    assert.ok(r.person && !picked.includes(r.person.id), "nobody twice in a round");
    picked.push(r.person!.id);
  }
  assert.equal(turnsLeft(pool, picked), 0);
  assert.equal(choose(pool, picked, "turns", 0.5).newRound, true);
  assert.equal(choose(pool, ["a", "b", "c"], "any", 0.99).newRound, false);
  assert.equal(choose([], [], "turns", 0.3).person, null);
  assert.equal(turnsLeft(pool, ["a"]), 2, "a student on two devices counts once");
});

test("noise: level curve, words and the colour against the line", () => {
  assert.equal(rmsToLevel(0), 0);
  assert.equal(rmsToLevel(1), 100);
  assert.ok(rmsToLevel(0.01) < rmsToLevel(0.1));
  assert.ok(smooth(0, 100) - 0 > 100 - smooth(100, 0), "rises faster than it falls");
  assert.equal(noiseWord(5), "noiseSilent");
  assert.equal(noiseWord(40), "noiseWork");
  assert.equal(noiseWord(100), "noiseOver");
  assert.equal(noiseColour(10, 55).background, "#1b7f4b");
  assert.equal(noiseColour(80, 55).background, "#ec3013");
  assert.match(noiseColour(35, 55).background, /^color-mix\(in oklch/);
});
