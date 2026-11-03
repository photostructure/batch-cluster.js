import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, test } from "node:test";

const SCRIPT = join(import.meta.dirname, "release-changelog.mjs");
let dir;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(changelog, ...args) {
  dir = mkdtempSync(join(tmpdir(), "release-changelog-"));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return {
    ...result,
    changelog: readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
  };
}

const RELEASED =
  "## [1.2.3] - 2026-01-02\n\n- Old fix.\n\n[1.2.3]: https://example.com/v1.2.3\n";

describe("bump", () => {
  for (const bump of ["patch", "minor", "major"]) {
    test(`prints ${bump}`, () => {
      const r = run(
        `# Changelog\n\n## [Unreleased (${bump})]\n\n- New.\n\n${RELEASED}`,
        "bump",
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${bump}\n`);
    });
  }

  const failures = [
    [
      "no Unreleased heading",
      RELEASED,
      'has no "## [Unreleased (patch|minor|major)]" heading',
    ],
    [
      "a heading without a bump",
      `## [Unreleased]\n\n- New.\n\n${RELEASED}`,
      "does not name a version bump",
    ],
    [
      "an unknown bump",
      `## [Unreleased (huge)]\n\n- New.\n\n${RELEASED}`,
      '"huge" on line 1',
    ],
    [
      "a misspelled heading",
      `## Unreleased (minor)\n\n- New.\n\n${RELEASED}`,
      "is not a valid Unreleased heading",
    ],
    [
      "an empty section",
      `## [Unreleased (minor)]\n\n\n${RELEASED}`,
      "section of CHANGELOG.md is empty",
    ],
    [
      "two Unreleased headings",
      `## [Unreleased (minor)]\n\n- A.\n\n## [Unreleased (patch)]\n\n- B.\n`,
      "more than one Unreleased heading",
    ],
  ];
  for (const [name, changelog, message] of failures) {
    test(`explains ${name}`, () => {
      const r = run(changelog, "bump");
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^::error file=CHANGELOG\.md/);
      assert.ok(r.stderr.includes(message), r.stderr);
      assert.ok(
        r.stderr.includes("## [Unreleased (minor)]"),
        "shows an example heading",
      );
    });
  }
});

describe("stamp", () => {
  test("renames the section and adds a link definition", () => {
    const r = run(
      `# Changelog\n\n## [Unreleased (minor)]\n\n- New.\n\n${RELEASED}`,
      "stamp",
      "1.3.0",
      "2026-11-02",
      "https://example.com/v1.3.0",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.changelog,
      "# Changelog\n\n## [Unreleased]\n\n## [1.3.0] - 2026-11-02\n\n- New.\n\n" +
        "## [1.2.3] - 2026-01-02\n\n- Old fix.\n\n" +
        "[1.3.0]: https://example.com/v1.3.0\n[1.2.3]: https://example.com/v1.2.3\n",
    );
  });

  test("appends the link definition when there are none", () => {
    const r = run(
      "## [Unreleased (patch)]\n\n- Fix.\n",
      "stamp",
      "0.0.1",
      "2026-11-02",
      "https://example.com/0.0.1",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.changelog,
      "## [Unreleased]\n\n## [0.0.1] - 2026-11-02\n\n- Fix.\n\n[0.0.1]: https://example.com/0.0.1\n",
    );
  });

  test("refuses a version that is already in the file", () => {
    const r = run(
      `## [Unreleased (patch)]\n\n- Fix.\n\n${RELEASED}`,
      "stamp",
      "1.2.3",
      "2026-11-02",
      "https://example.com/v1.2.3",
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already has a ## \[1\.2\.3\] heading/);
  });

  test("leaves the file unchanged when the Unreleased heading is invalid", () => {
    const changelog = `## [Unreleased]\n\n- New.\n\n${RELEASED}`;
    const r = run(
      changelog,
      "stamp",
      "1.3.0",
      "2026-11-02",
      "https://example.com/v1.3.0",
    );
    assert.equal(r.status, 1);
    assert.equal(r.changelog, changelog);
  });
});
