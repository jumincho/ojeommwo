import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let dependencyRequire = createRequire(fs.realpathSync(path.join(root, "node_modules/vinext/package.json")));
for (const dependency of ["vite-plugin-commonjs", "vite-plugin-dynamic-import", "fast-glob", "micromatch"]) {
  dependencyRequire = createRequire(dependencyRequire.resolve(dependency));
}
const entry = dependencyRequire.resolve("braces");

test("braces rejects deep patterns and supplied ASTs without exhausting the stack", () => {
  const source = [
    'const assert = require("node:assert/strict");',
    'const braces = require(process.argv[1]);',
    'const rejectsDepth = (fn) => assert.throws(fn, (error) => error instanceof SyntaxError && error.code === "ERR_BRACES_MAX_DEPTH");',
    'for (const [open, close] of [["{", "}"], ["(", ")"]]) {',
    '  const balanced = open.repeat(4000) + "a,b" + close.repeat(4000);',
    '  const unbalanced = open.repeat(4000) + "a,b";',
    '  for (const value of [balanced, unbalanced]) for (const method of ["parse", "compile", "expand", "stringify"]) rejectsDepth(() => braces[method](value, {maxDepth: Infinity, maxLength: 65536}));',
    '}',
    'for (const method of ["compile", "expand", "stringify"]) {',
    '  let ast = { type: "text", value: "x" };',
    '  for (let depth = 0; depth < 12000; depth++) ast = {type: "root", nodes: [ast]};',
    '  rejectsDepth(() => braces[method](ast));',
    '}',
    'assert.deepEqual(braces.expand("src/{app,lib}/file-{1..3}.js"), ["src/app/file-1.js","src/app/file-2.js","src/app/file-3.js","src/lib/file-1.js","src/lib/file-2.js","src/lib/file-3.js"]);',
    'assert.equal(braces.compile("a/{b,c}/d"), "a/(b|c)/d");',
    'assert.equal(braces.stringify(braces.parse("a/{b,c}/d")), "a/{b,c}/d");',
    'assert.equal(braces.compile("{".repeat(32)+"a,b"+"}".repeat(32)).length > 0, true);',
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", source, entry], {encoding: "utf8", timeout: 3000, maxBuffer: 65536});
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
