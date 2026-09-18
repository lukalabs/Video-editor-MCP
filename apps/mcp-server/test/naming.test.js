import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MCP_PROJECT_SUFFIX,
  withMcpProjectSuffix,
  findDuplicateProject,
} from "../src/naming.js";

/**
 * The suffix rule is enforced server-side so it cannot be forgotten by a calling agent, which
 * means the rule itself is the thing worth pinning down.
 */

test("appends the suffix to a plain name", () => {
  assert.equal(withMcpProjectSuffix("Summer Sale Promo"), "Summer Sale Promo-MCP");
  assert.equal(withMcpProjectSuffix("Q4 product launch teaser"), "Q4 product launch teaser-MCP");
});

test("does not double an already-suffixed name", () => {
  assert.equal(withMcpProjectSuffix("Launch teaser-MCP"), "Launch teaser-MCP");
});

test("recognises an existing suffix regardless of case, and normalises it", () => {
  // Normalised so a case-sensitive filter over the project list still finds every one of them.
  for (const variant of ["-mcp", "-Mcp", "-mCp", "-MCP"]) {
    assert.equal(withMcpProjectSuffix(`Launch teaser${variant}`), "Launch teaser-MCP");
  }
});

test("still marks a missing or blank name", () => {
  // project-kit would fall back to "Untitled", and an unsuffixed project is the whole thing
  // this prevents.
  for (const empty of [undefined, null, "", "   ", 42, {}]) {
    assert.equal(withMcpProjectSuffix(empty), "Untitled-MCP");
  }
});

test("trims surrounding whitespace before appending", () => {
  assert.equal(withMcpProjectSuffix("  Launch teaser  "), "Launch teaser-MCP");
});

test("a name that merely contains the suffix mid-string is still suffixed", () => {
  assert.equal(withMcpProjectSuffix("-MCP rollout plan"), "-MCP rollout plan-MCP");
});

test("the exported suffix constant is what gets applied", () => {
  assert.ok(withMcpProjectSuffix("anything").endsWith(MCP_PROJECT_SUFFIX));
});

/**
 * Duplicate detection. The project list genuinely accumulated "Agent Built" three times
 * and "MCP-claude-test-2-MCP" twice, because create_project minted a fresh uuid every
 * call and compared nothing.
 */

const PROJECTS = [
  { id: "p1", name: "Halloween - grwm-MCP", folder: "Halloween" },
  { id: "p2", name: "Agent Built-MCP", folder: "Uncategorized" },
  { id: "p3", name: "Intro-MCP", folder: "Client Acme" },
];

test("finds a project with the same name in the same folder", () => {
  const found = findDuplicateProject(PROJECTS, "Agent Built-MCP", "Uncategorized");
  assert.equal(found?.id, "p2");
});

test("treats a missing folder as the default bucket", () => {
  assert.equal(findDuplicateProject(PROJECTS, "Agent Built-MCP", undefined)?.id, "p2");
  assert.equal(findDuplicateProject(PROJECTS, "Agent Built-MCP", "")?.id, "p2");
  assert.equal(findDuplicateProject(PROJECTS, "Agent Built-MCP", "   ")?.id, "p2");
});

test("ignores case and surrounding whitespace on both sides", () => {
  assert.equal(findDuplicateProject(PROJECTS, "  agent built-mcp ", "UNCATEGORIZED")?.id, "p2");
});

test("does not match the same name in a different folder", () => {
  // Two projects called "Intro" under different clients are different work.
  assert.equal(findDuplicateProject(PROJECTS, "Intro-MCP", "Client Beta"), null);
});

test("does not match a different name in the same folder", () => {
  assert.equal(findDuplicateProject(PROJECTS, "Halloween - block 2-MCP", "Halloween"), null);
});

test("returns null for a blank name or a list that is not one", () => {
  assert.equal(findDuplicateProject(PROJECTS, "", "Halloween"), null);
  assert.equal(findDuplicateProject(PROJECTS, "   ", "Halloween"), null);
  assert.equal(findDuplicateProject(undefined, "Agent Built-MCP", "Uncategorized"), null);
});

test("tolerates rows without a folder, which the service reports as uncategorised", () => {
  const rows = [{ id: "p9", name: "Loose-MCP" }];
  assert.equal(findDuplicateProject(rows, "Loose-MCP", undefined)?.id, "p9");
});
