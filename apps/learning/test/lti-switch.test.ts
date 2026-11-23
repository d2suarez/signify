import { test } from "node:test";
import assert from "node:assert/strict";
import { ltiToolMode } from "../src/lib/lti-switch";
import { kickScores } from "../src/lib/lti-ags";
import * as deep from "../src/app/lti/deep/[id]/route";
import * as deepPost from "../src/app/lti/deep/[id]/post/route";

// Desmond, 2026-11-23: Learning no longer connects to other LMSs as a tool.
// The code stays behind one switch, off unless LEARNING_LTI_TOOL_MODE=1.

test("LTI tool mode is off unless the service turns it on", () => {
  delete process.env.LEARNING_LTI_TOOL_MODE;
  assert.equal(ltiToolMode(), false);
  process.env.LEARNING_LTI_TOOL_MODE = "true";
  assert.equal(ltiToolMode(), false, "only exactly 1");
  delete process.env.LEARNING_LTI_TOOL_MODE;
});

// login, launch and scores import server-only modules (not loadable here); they open with the same line.
test("while off, Schoology's routes answer 404 and nothing reads the request", async () => {
  delete process.env.LEARNING_LTI_TOOL_MODE;
  const req = () => new Request("https://learn.test/lti/x", { method: "POST", body: "id_token=x&state=y", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const params = { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) };
  for (const [name, res] of [
    ["deep link poll", await deep.GET(req(), params)],
    ["deep link post", await deepPost.GET(req(), params)],
  ] as const) assert.equal(res.status, 404, name);
});

test("while off, no grade is queued or sent to Schoology", async () => {
  delete process.env.LEARNING_LTI_TOOL_MODE;
  // passBack (server-only, so not importable here) returns on the same switch
  // before anything else; the sender itself refuses to start.
  kickScores();
  const worker = (globalThis as unknown as { __learningAgs?: { timer?: unknown } }).__learningAgs;
  assert.equal(worker?.timer, undefined, "no sending loop started");
});
