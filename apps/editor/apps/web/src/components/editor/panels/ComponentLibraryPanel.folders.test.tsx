/**
 * The Component Library panel's folders: grouped headings, the folder filter, and Move.
 *
 * The render service is faked at the fetch boundary, so what is checked is exactly what the
 * panel sends and how it lays out what comes back - including that Move goes over PATCH
 * with the typed folder and the list regroups afterwards.
 */
import "../../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ComponentLibraryPanel } from "./ComponentLibraryPanel";

type Meta = { id: string; name: string; description: string; folder: string; params: unknown[] };

let catalogue: Meta[];
let patches: Array<{ url: string; body: unknown }>;

const meta = (id: string, name: string, folder: string): Meta => ({
  id,
  name,
  description: `${name} description`,
  folder,
  params: [],
});

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  catalogue = [
    meta("button-shimmer", "Button Shimmer", "Buttons"),
    meta("button-press-3d", "Button Press 3D", "Buttons"),
    meta("chat-thread-Rep", "Chat Thread Rep", "Chat"),
    meta("stat-counter", "Stat Counter", "Uncategorized"),
  ];
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((...[input, init]: Parameters<typeof fetch>) => {
      const url = String(input);
      if (init?.method === "PATCH" && /\/components\/[^/]+\/folder$/.test(url)) {
        const body = JSON.parse(String(init.body)) as { folder: string };
        patches.push({ url, body });
        const id = decodeURIComponent(url.split("/components/")[1].split("/")[0]);
        const folder = body.folder.trim() || "Uncategorized";
        catalogue = catalogue.map((c) => (c.id === id ? { ...c, folder } : c));
        return json({ id, folder });
      }
      if (url.endsWith("/components/folders")) {
        return json({ folders: [...new Set(catalogue.map((c) => c.folder))].sort() });
      }
      if (url.endsWith("/components")) return json({ components: catalogue });
      if (url.endsWith("/component-metadata")) return json({ entries: [] });
      return json({ error: "not faked" }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const headings = () =>
  screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.trim());

describe("ComponentLibraryPanel folders", () => {
  it("groups the catalogue by folder, alphabetically, with the default folder last", async () => {
    render(<ComponentLibraryPanel />);
    await screen.findByRole("button", { name: "Select component Button Shimmer" });

    expect(headings()).toEqual(["Buttons (2)", "Chat (1)", "Uncategorized (1)"]);
    const buttons = screen.getByRole("region", { name: "Component folder Buttons" });
    expect(within(buttons).getByRole("button", { name: "Select component Button Press 3D" })).toBeTruthy();
  });

  it("filters to one folder", async () => {
    render(<ComponentLibraryPanel />);
    await screen.findByRole("button", { name: "Select component Button Shimmer" });

    fireEvent.change(screen.getByRole("combobox", { name: "Filter components by folder" }), {
      target: { value: "Chat" },
    });

    expect(headings()).toEqual(["Chat (1)"]);
    expect(screen.queryByRole("button", { name: "Select component Button Shimmer" })).toBeNull();
  });

  it("moves the selected component over PATCH and regroups", async () => {
    render(<ComponentLibraryPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Select component Stat Counter" }));
    expect(screen.getByText(/Folder: Uncategorized/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move Stat Counter to another folder" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Move Stat Counter to folder" }), {
      target: { value: "  Text  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(headings()).toEqual(["Buttons (2)", "Chat (1)", "Text (1)"]));
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/components\/stat-counter\/folder$/);
    expect(patches[0].body).toEqual({ folder: "Text" });
  });
});
