import { listComponents } from "./components.js";
import {
  ComponentFolderError,
  DEFAULT_COMPONENT_FOLDER,
  listComponentFolders,
  setComponentFolder,
  withFolder,
} from "./component-folders.js";

/**
 * The component catalogue and its folders.
 *
 *   GET   /components?folder=X    the catalogue, each entry carrying `folder`; optional filter
 *   GET   /components/folders     the folder names in use
 *   PATCH /components/:id/folder  { folder } - re-file one component ("" clears)
 *
 * A folder is a field in the component's tracked meta.json, so re-filing is a one-line
 * change to that file - see component-folders.js. No authentication, localhost only.
 */
export async function registerComponentRoutes(app) {
  app.get("/components", async (request) => {
    const all = (await listComponents()).map(withFolder);
    const folder = request.query?.folder;
    if (typeof folder !== "string" || folder.trim() === "") return { components: all };
    // Asking for the default folder means "the unfiled ones", which report that name.
    const wanted = folder.trim();
    return { components: all.filter((meta) => meta.folder === wanted) };
  });

  app.get("/components/folders", async () => ({ folders: await listComponentFolders() }));

  app.patch("/components/:id/folder", async (request, reply) => {
    try {
      return await setComponentFolder(request.params.id, request.body?.folder);
    } catch (error) {
      if (error instanceof ComponentFolderError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
}

export { DEFAULT_COMPONENT_FOLDER };
