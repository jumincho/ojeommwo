import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSourceSeal, serializeSourceSeal } from "../scripts/generate-source-seal.js";

const STATIC_FIXTURES = [
  "holiday-skip-dates.json",
  "recommendations.json",
  "recommendations.sample.json"
];

function write(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-source-seal-test-"));
  write(root, "package.json", '{"name":"seal-fixture","version":"9.8.7","type":"module"}\n');
  write(root, "src/version.js", [
    'export const RELEASE = Object.freeze({',
    '  version: "9.8.7",',
    '  date: "2030-01-02",',
    '  implementationModel: "Fixture Model",',
    '  label: "9.8.7 fixture"',
    '});',
    ''
  ].join("\n"));
  write(root, "src/service.js", 'export const service = "stable";\n');
  write(root, "scripts/runner.js", 'console.log("fixture");\n');
  write(root, "prompts/schema.json", '{"type":"object"}\n');
  write(root, "config/meal-normalization-aliases.json", '{"version":1,"entries":[]}\n');
  for (const name of STATIC_FIXTURES) write(root, `data/${name}`, `{"fixture":"${name}"}\n`);
  return root;
}

test("source seal is deterministic and carries the release declared by src/version.js", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await buildSourceSeal({ root });
  const second = await buildSourceSeal({ root });
  assert.deepEqual(second, first);
  assert.equal(serializeSourceSeal(second), serializeSourceSeal(first));
  assert.deepEqual(first.release, {
    version: "9.8.7",
    date: "2030-01-02",
    implementationModel: "Fixture Model",
    label: "9.8.7 fixture"
  });
  assert.equal(first.sourceSeal.algorithm, "sha256");
  assert.match(first.sourceSeal.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.sourceSeal.fileCount, 9);
});

test("dynamic data and secrets are excluded from the runtime source seal", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = await buildSourceSeal({ root });

  write(root, "data/recommendation-history.json", '{"items":["dynamic"]}\n');
  write(root, "data/verified-candidates.json", '{"candidates":["dynamic"]}\n');
  write(root, ".env", "SLACK_BOT_TOKEN=secret\n");
  write(root, "logs/runtime.log", "dynamic\n");

  assert.deepEqual(await buildSourceSeal({ root }), before);
});

test("runtime source and immutable fixture mutations change the SHA-256 seal", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initial = await buildSourceSeal({ root });

  write(root, "src/service.js", 'export const service = "changed";\n');
  const sourceChanged = await buildSourceSeal({ root });
  assert.notEqual(sourceChanged.sourceSeal.sha256, initial.sourceSeal.sha256);
  assert.equal(sourceChanged.sourceSeal.fileCount, initial.sourceSeal.fileCount);

  write(root, "data/holiday-skip-dates.json", '{"fixture":"changed"}\n');
  const fixtureChanged = await buildSourceSeal({ root });
  assert.notEqual(fixtureChanged.sourceSeal.sha256, sourceChanged.sourceSeal.sha256);
});

test("source seal is byte-exact and distinguishes LF from CRLF", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "src/service.js", "export const one = 1;\nexport const two = 2;\n");
  const lf = await buildSourceSeal({ root });
  write(root, "src/service.js", "export const one = 1;\r\nexport const two = 2;\r\n");
  const crlf = await buildSourceSeal({ root });
  assert.notEqual(crlf.sourceSeal.sha256, lf.sourceSeal.sha256);
  assert.equal(crlf.sourceSeal.fileCount, lf.sourceSeal.fileCount);
});

test("source seal rejects non-files and enforces traversal bounds", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.rmSync(path.join(root, "data", "recommendations.json"));
  fs.mkdirSync(path.join(root, "data", "recommendations.json"));
  await assert.rejects(buildSourceSeal({ root }), /recommendations\.json is not a regular file/u);

  fs.rmSync(path.join(root, "data", "recommendations.json"), { recursive: true });
  write(root, "data/recommendations.json", '{}\n');
  await assert.rejects(buildSourceSeal({ root, limits: { maxFiles: 8 } }), /8-file bound/u);
  write(root, "src/nested/deeper/file.js", "export {};\n");
  await assert.rejects(buildSourceSeal({ root, limits: { maxDepth: 2 } }), /2-level depth bound/u);
});

test("source seal rejects a symlink or junction that could escape the project root", async (t) => {
  const root = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-source-seal-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  write(outside, "escaped.js", "export {};\n");
  const linkPath = path.join(root, "src", "escape");
  try {
    fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(buildSourceSeal({ root }), /symbolic link or junction/u);
});

test("integrated observatory source is sealed while generated data is excluded", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "VERSION",
    "next.config.ts", "vite.config.ts", "tsconfig.json", "eslint.config.mjs",
    "run-pororo.sh", "public/icon.svg", "public/og.png"]) {
    write(root, `observatory/${name}`, "fixture");
  }
  for (const name of ["app", "build", "scripts", "worker", "patches", ".openai"]) {
    write(root, `observatory/${name}/fixture.txt`, "fixture");
  }
  const before = await buildSourceSeal({ root });
  write(root, "observatory/public/data/snapshot.json", "dynamic");
  write(root, "observatory/out/index.html", "generated");
  assert.deepEqual(await buildSourceSeal({ root }), before);
  write(root, "observatory/app/fixture.txt", "changed");
  assert.notEqual((await buildSourceSeal({ root })).sourceSeal.sha256, before.sourceSeal.sha256);
  fs.rmSync(path.join(root, "observatory/worker"), { recursive: true });
  await assert.rejects(buildSourceSeal({ root }), /observatory.*worker/);
});

test("source seal accepts product minor version only with the matching zero-patch semver", async (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const versionPath = path.join(root, "src", "version.js");
  fs.writeFileSync(versionPath, fs.readFileSync(versionPath, "utf8").replace('version: "9.8.7"', 'version: "2.5"'));
  write(root, "package.json", '{"name":"seal-fixture","version":"2.5.0","type":"module"}\n');
  assert.equal((await buildSourceSeal({ root })).release.version, "2.5");
  write(root, "package.json", '{"name":"seal-fixture","version":"2.5.1","type":"module"}\n');
  await assert.rejects(buildSourceSeal({ root }), /does not match/);
});
