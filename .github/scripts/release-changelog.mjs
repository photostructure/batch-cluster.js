// Reads and stamps the `## [Unreleased (patch|minor|major)]` section of
// CHANGELOG.md for the release workflow. Run it from the repository root.
//
//   node .github/scripts/release-changelog.mjs bump
//     Prints patch, minor, or major. Fails, explaining the fix, unless
//     CHANGELOG.md has exactly one Unreleased heading that names a bump and has
//     notes under it.
//
//   node .github/scripts/release-changelog.mjs stamp <version> <date> <url>
//     Renames that heading to `## [<version>] - <date>`, adds an empty
//     `## [Unreleased]` above it, and adds a `[<version>]: <url>` link
//     definition.
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const FILE = "CHANGELOG.md";
const BUMPS = ["patch", "minor", "major"];
const EXAMPLE = [
  "Example:",
  "",
  "  ## [Unreleased (minor)]",
  "",
  "  - ✨ Added the `foo` option.",
  "",
  "Commit the change to the default branch, then start the release again.",
];

function fail(line, summary, details) {
  const where = line == null ? "" : `,line=${line}`;
  console.error(`::error file=${FILE}${where}::${summary}`);
  console.error([summary, "", ...details, "", ...EXAMPLE].join("\n"));
  process.exit(1);
}

function readUnreleased(lines) {
  const candidates = [];
  lines.forEach((text, i) => {
    if (/^#+ .*unreleased/i.test(text)) candidates.push(i);
  });
  if (candidates.length === 0) {
    fail(
      null,
      `${FILE} has no "## [Unreleased (patch|minor|major)]" heading.`,
      [
        "Add that heading above the newest release and list this release's",
        "changes under it.",
      ],
    );
  }
  if (candidates.length > 1) {
    fail(candidates[1] + 1, `${FILE} has more than one Unreleased heading.`, [
      `Lines ${candidates.map((i) => i + 1).join(", ")} all look like Unreleased`,
      "headings. Merge their notes under one heading.",
    ]);
  }
  const index = candidates[0];
  const heading = lines[index];
  const prefix = "## [Unreleased (";
  let bump;
  if (heading.startsWith(prefix) && heading.endsWith(")]")) {
    bump = heading.slice(prefix.length, -2);
  } else if (heading !== "## [Unreleased]") {
    fail(
      index + 1,
      `Line ${index + 1} of ${FILE} is not a valid Unreleased heading.`,
      [
        `It reads "${lines[index]}". Write it exactly as`,
        '"## [Unreleased (patch)]", "## [Unreleased (minor)]", or',
        '"## [Unreleased (major)]".',
      ],
    );
  }
  if (bump == null) {
    fail(
      index + 1,
      `The Unreleased heading in ${FILE} does not name a version bump.`,
      [
        `Change line ${index + 1} from "## [Unreleased]" to "## [Unreleased (patch)]",`,
        '"## [Unreleased (minor)]", or "## [Unreleased (major)]".',
      ],
    );
  }
  if (!BUMPS.includes(bump)) {
    fail(
      index + 1,
      `"${bump}" on line ${index + 1} of ${FILE} is not a version bump.`,
      ['The bump must be "patch", "minor", or "major".'],
    );
  }
  let end = index + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  if (!lines.slice(index + 1, end).some((text) => /\S/.test(text))) {
    fail(index + 1, `The Unreleased section of ${FILE} is empty.`, [
      `List this release's changes under line ${index + 1}. They become the GitHub`,
      "release notes.",
    ]);
  }
  return { index, bump };
}

const [mode, ...args] = process.argv.slice(2);
const lines = readFileSync(FILE, "utf8").split("\n");

if (mode === "bump" && args.length === 0) {
  console.log(readUnreleased(lines).bump);
} else if (mode === "stamp" && args.length === 3) {
  const [version, date, url] = args;
  if (lines.some((text) => text.startsWith(`## [${version}]`))) {
    throw new Error(`${FILE} already has a ## [${version}] heading`);
  }
  const { index } = readUnreleased(lines);
  lines.splice(index, 1, "## [Unreleased]", "", `## [${version}] - ${date}`);
  const def = `[${version}]: ${url}`;
  const firstDef = lines.findIndex(
    (text) => /^\[\d/.test(text) && text.includes("]: "),
  );
  if (firstDef === -1) {
    while (lines.at(-1) === "") lines.pop();
    lines.push("", def, "");
  } else {
    lines.splice(firstDef, 0, def);
  }
  writeFileSync(FILE, lines.join("\n"));
} else {
  throw new Error(
    "usage: release-changelog.mjs bump | release-changelog.mjs stamp <version> <date> <url>",
  );
}
