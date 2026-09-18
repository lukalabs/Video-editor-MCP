/**
 * Naming rules the MCP server enforces on what it creates.
 *
 * Lives in its own module because `index.js` builds and connects the stdio server as a side
 * effect of being imported, so a unit test cannot import the helper from there.
 */

/**
 * What the service calls a project with no folder. Duplicated from index.js for the
 * same reason it is duplicated there: this package talks to the render service over
 * HTTP only and never imports its internals.
 */
export const DEFAULT_PROJECT_FOLDER = "Uncategorized";

/** The suffix every project created through this server carries. */
export const MCP_PROJECT_SUFFIX = "-MCP";

/**
 * Marks a project name as MCP-created.
 *
 * Enforced here rather than documented for the calling agent, because a convention that
 * depends on the agent remembering it is a convention that gets dropped — this session lost
 * the `-Rep` component suffix, a shared-assets request and a five-component deletion that
 * way. Server-side, the guarantee holds whatever the caller passes.
 *
 * An already-suffixed name is not doubled. The comparison is case-insensitive and the suffix
 * is normalised to its canonical casing, so the resulting names are uniform enough for a
 * case-sensitive filter over the project list.
 *
 * An empty or missing name still gets the suffix: project-kit would otherwise fall back to
 * "Untitled", and an unsuffixed project is exactly what this is meant to prevent.
 */
export function withMcpProjectSuffix(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  const base = trimmed === "" ? "Untitled" : trimmed;

  if (base.toLowerCase().endsWith(MCP_PROJECT_SUFFIX.toLowerCase())) {
    return base.slice(0, base.length - MCP_PROJECT_SUFFIX.length) + MCP_PROJECT_SUFFIX;
  }
  return base + MCP_PROJECT_SUFFIX;
}


/**
 * Finds a project that an agent is probably about to recreate.
 *
 * `create_project` mints a fresh uuid on every call and checks nothing, so an agent
 * iterating on one idea produces N rows with one name - this session's project list
 * held "Agent Built" three times and "MCP-claude-test-2-MCP" twice. Reusing the folder
 * is advised in the tool description, but advice an agent has to remember is advice that
 * gets dropped, so the match happens server-side like the -MCP suffix does.
 *
 * Name and folder both have to match: two projects called "Intro" under different
 * clients are different work, while two called "Intro" in the same folder are almost
 * always the same intent twice.
 */
export function findDuplicateProject(projects, name, folder) {
  if (!Array.isArray(projects)) return null;
  const wantedName = String(name ?? "").trim().toLowerCase();
  if (wantedName === "") return null;
  const wantedFolder = normaliseFolderForMatch(folder);

  return (
    projects.find(
      (project) =>
        String(project?.name ?? "").trim().toLowerCase() === wantedName &&
        normaliseFolderForMatch(project?.folder) === wantedFolder,
    ) ?? null
  );
}

/** Absent, blank and the default label all mean the same uncategorised bucket. */
function normaliseFolderForMatch(folder) {
  const trimmed = typeof folder === "string" ? folder.trim() : "";
  if (trimmed === "") return DEFAULT_PROJECT_FOLDER.toLowerCase();
  return trimmed.toLowerCase();
}
