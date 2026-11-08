import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeSilent, classify } from "./worker.mjs";

const H = 60 * 60 * 1000;

test("judgeSilent: run 無し+活動ありで無音", () => {
  assert.equal(judgeSilent({ runAgeMs: null, pushAgeMs: 1000 }), true);
  assert.equal(judgeSilent({ runAgeMs: 3 * H, pushAgeMs: 1000 }), true);
});
test("judgeSilent: 活動が無い静寂は無音にしない", () => {
  assert.equal(judgeSilent({ runAgeMs: 5 * H, pushAgeMs: 5 * H }), false);
});
test("judgeSilent: 直近 run ありは正常", () => {
  assert.equal(judgeSilent({ runAgeMs: 1000, pushAgeMs: 1000 }), false);
});
test("classify: target のみ無音 → repo-specific", () => {
  const r = classify([
    { repo: "azumag/docich", silent: true },
    { repo: "azumag/twica", silent: false },
    { repo: "azumag/soviet_now", silent: false },
  ]);
  assert.equal(r.alert, true);
  assert.match(r.classification, /repo-specific/);
});
test("classify: control も無音 → platform-suspect", () => {
  const r = classify([
    { repo: "azumag/docich", silent: true },
    { repo: "azumag/twica", silent: true },
    { repo: "azumag/soviet_now", silent: false },
  ]);
  assert.equal(r.alert, true);
  assert.match(r.classification, /platform-suspect/);
});
test("classify: target 正常 → 通知なし", () => {
  const r = classify([
    { repo: "azumag/docich", silent: false },
    { repo: "azumag/twica", silent: true },
    { repo: "azumag/soviet_now", silent: false },
  ]);
  assert.equal(r.alert, false);
});
