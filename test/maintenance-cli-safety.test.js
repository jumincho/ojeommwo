import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runScript(name, args) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", name), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" }
  });
}

test("mutating maintenance CLIs reject unknown arguments before work", () => {
  for (const name of ["rebuild-candidate-catalog.js", "normalize-meal-events.js", "migrate-food-taxonomy.js"]) {
    const result = runScript(name, ["--unknown-maintenance-flag"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown argument/u);
  }
});

test("taxonomy external-fence mode is apply-only and token-bound", () => {
  const withoutApply = runScript("migrate-food-taxonomy.js", ["--externally-fenced"]);
  assert.notEqual(withoutApply.status, 0);
  assert.match(withoutApply.stderr, /requires --apply/u);

  const taxonomy = fs.readFileSync(path.join(ROOT, "scripts", "migrate-food-taxonomy.js"), "utf8");
  assert.match(taxonomy, /OJEOMMWO_MAINTENANCE_TOKEN/u);
  assert.match(taxonomy, /integrated-source-deployment/u);
  assert.match(taxonomy, /marker\?\.token !== fenceToken/u);
});

test("catalog rebuild is non-mutating by default and verified reset requires explicit force", () => {
  const catalog = fs.readFileSync(path.join(ROOT, "scripts", "rebuild-candidate-catalog.js"), "utf8");
  const addSeeds = fs.readFileSync(path.join(ROOT, "scripts", "add-candidate-catalog-seeds.js"), "utf8");
  const normalization = fs.readFileSync(path.join(ROOT, "scripts", "normalize-meal-events.js"), "utf8");
  const taxonomy = fs.readFileSync(path.join(ROOT, "scripts", "migrate-food-taxonomy.js"), "utf8");
  assert.match(catalog, /const apply = argumentsList\.includes\("--apply"\)/u);
  assert.match(catalog, /if \(apply\)[\s\S]*updateVerifiedCandidateCatalog/u);
  assert.match(addSeeds, /if \(apply\)[\s\S]*updateVerifiedCandidateCatalog/u);
  assert.match(normalization, /--force-reset-verified/u);
  assert.match(normalization, /Refusing to reset[^\n]+verified custom meal events/u);
  assert.match(normalization, /prepareMealEventsAtomically[\s\S]*updateMealEventsByIdAtomically/u);
  assert.match(normalization, /successful items remain committed and reruns are idempotent/u);
  assert.match(taxonomy, /const apply = values\.has\("--apply"\)/u);
  assert.match(taxonomy, /\.operating-maintenance/u);
  assert.match(taxonomy, /synchronizeBackup: true/u);
  assert.match(taxonomy, /recovery snapshot/u);
});
