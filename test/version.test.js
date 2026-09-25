import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { RELEASE, RELEASE_DATE, RELEASE_IMPLEMENTATION_MODEL, RELEASE_LABEL, SERVICE_VERSION } from "../src/version.js";
test("v3 package and immutable release metadata agree", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(`${SERVICE_VERSION}.0`, pkg.version);
  assert.equal(SERVICE_VERSION, "3.0");
  assert.match(RELEASE_DATE, /^2026-09-25T\d{2}:\d{2}:\d{2}\+09:00$/u);
  assert.ok(Number.isFinite(Date.parse(RELEASE_DATE)));
  assert.equal(RELEASE_IMPLEMENTATION_MODEL, "GPT-6 Astra Max");
  assert.equal(RELEASE_LABEL, `${SERVICE_VERSION} · ${RELEASE_DATE} · ${RELEASE_IMPLEMENTATION_MODEL}`);
  assert.equal(RELEASE.label, RELEASE_LABEL);
  assert.equal(Object.isFrozen(RELEASE), true);
});
