import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ground truth: the maintainer-approved PUBLISH-SAFER package boundary. The
// public tarball contains runtime output and standard package documents, never
// compiled specs, subprocess fixtures, or maintainer-only calibration tools.
assert(
  process.env.npm_execpath,
  "run this check through npm run check:package",
);
const tempDirectory = mkdtempSync(join(tmpdir(), "batch-cluster-pack-check-"));
const reportPath = join(tempDirectory, "PACK.json");
const reportFile = openSync(reportPath, "w");
let reportFileOpen = true;
let reports;
try {
  execFileSync(
    process.execPath,
    [
      process.env.npm_execpath,
      "pack",
      "--dry-run",
      "--json",
      "--ignore-scripts",
    ],
    {
      stdio: ["ignore", reportFile, "inherit"],
    },
  );
  closeSync(reportFile);
  reportFileOpen = false;
  reports = JSON.parse(readFileSync(reportPath, "utf8"));
} finally {
  if (reportFileOpen) closeSync(reportFile);
  rmSync(tempDirectory, { force: true, recursive: true });
}

assert.equal(reports.length, 1, "npm pack must report exactly one package");
const [report] = reports;
assert.equal(report.name, "batch-cluster");

const documents = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
]);
const forbiddenRuntimeOutput = [
  /(?:^|\/)[^/]*\.spec\./,
  /(?:^|\/)test\./,
  /(?:^|\/)test-helpers\./,
  /(?:^|\/)[^/]*-helper\./,
  /(?:^|\/)find-flush-thresholds\./,
  /(?:^|\/)FlushThresholdTestHelpers\./,
  /(?:^|\/)TestEnv\./,
];

const files = report.files.map(({ path }) => path);
const unexpected = files.filter((path) => {
  if (documents.has(path)) return false;
  if (!path.startsWith("dist/")) return true;
  return forbiddenRuntimeOutput.some((pattern) => pattern.test(path));
});

assert.deepEqual(
  unexpected,
  [],
  `unexpected files in npm package:\n${unexpected.join("\n")}`,
);
for (const required of ["dist/BatchCluster.js", "dist/BatchCluster.d.ts"]) {
  assert(files.includes(required), `npm package is missing ${required}`);
}

console.log(`Verified ${files.length} npm package entries.`);
