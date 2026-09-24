import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dependencyRequire = createRequire(fs.realpathSync(path.join(root, "node_modules/vinext/package.json")));
const cjsEntry = dependencyRequire.resolve("image-size");

for (const extension of ["cjs", "mjs"]) {
  test("image-size " + extension + " terminates on zero-size ICNS/HEIF/JXL and keeps valid images", () => {
    const entry = cjsEntry.replace(/\.cjs$/u, "." + extension);
    const source = [
      'import assert from "node:assert/strict";',
      'import { pathToFileURL } from "node:url";',
      'const { imageSize } = await import(pathToFileURL(process.argv[1]).href);',
      'function box(type, payload, size) { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(size ?? b.length); b.write(type, 4); payload.copy(b, 8); return b; }',
      'function icns(payload) { const b = Buffer.alloc(8 + payload.length); b.write("icns"); b.writeUInt32BE(b.length,4); payload.copy(b,8); return b; }',
      'function icon(length) { const b = Buffer.alloc(16); b.write("ic10"); b.writeUInt32BE(length,4); return b; }',
      'const zeroIcns = icns(icon(0));',
      'assert.throws(() => imageSize(zeroIcns), /ICNS/);',
      'for (const length of [1, 7, 0xffffffff]) { const bad = Buffer.from(zeroIcns); bad.writeUInt32BE(length, 12); assert.throws(() => imageSize(bad)); }',
      'const goodIcns = icns(icon(16)); assert.equal(imageSize(goodIcns).width, 1024);',
      'const dimensions = Buffer.alloc(12); dimensions.writeUInt32BE(37,4); dimensions.writeUInt32BE(23,8);',
      'const heif = Buffer.concat([box("ftyp",Buffer.from("heic0000")),box("meta",Buffer.concat([Buffer.alloc(4),box("iprp",box("ipco",box("ispe",dimensions,0)))]))]);',
      'assert.equal(imageSize(heif).width,37); assert.equal(imageSize(heif).height,23);',
      'const jxl = Buffer.concat([box("JXL ",Buffer.from([13,10,135,10])),box("ftyp",Buffer.from("jxl 0000")),box("jxlp",Buffer.alloc(4),0)]);',
      'assert.throws(() => imageSize(jxl));',
      'const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=","base64"); assert.equal(imageSize(png).width,1);',
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, entry], {
      encoding: "utf8", timeout: 3000, maxBuffer: 65536,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
  });
}
