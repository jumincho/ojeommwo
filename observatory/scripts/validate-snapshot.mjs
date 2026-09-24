#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { validateSnapshot } from "./lib/snapshot-schema.mjs";

const snapshotPath = path.resolve(process.argv[2] || "runtime/snapshot.json");
const raw = fs.readFileSync(snapshotPath, "utf8");
const snapshot = JSON.parse(raw);
validateSnapshot(snapshot);
process.stdout.write(`snapshot valid: ${snapshot.menus.length} menus, ${Buffer.byteLength(raw, "utf8")} bytes\n`);
