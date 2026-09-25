import React from "react";

import { DEFAULT_PROJECT_FOLDER } from "../../../services/server-storage";

/**
 * Pick an existing folder, or type a new one. Used for projects and for the component
 * catalogue, which share the same folder vocabulary and default name.
 *
 * One control rather than two: a text input backed by a `<datalist>`, which is a native
 * combobox — the dropdown offers what already exists and anything typed is accepted as a new
 * folder. A `<select>` plus a separate "new folder" field would make the common case (reuse
 * an existing folder) and the uncommon one (invent one) look equally heavy, and would need a
 * mode switch between them.
 *
 * `options` come from the server's own list (`GET /projects/folders` or
 * `GET /components/folders`), not folders derived from whatever happens to be loaded — see
 * ServerProjectsPanel.
 */
export interface FolderPickerProps {
  id: string;
  /** Current value. "" means the default folder. */
  value: string;
  onChange: (value: string) => void;
  /** Folder names to offer, from the server. */
  options: readonly string[];
  label: string;
  /** Screen-reader name; falls back to the visible label. */
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
}

export const FolderPicker: React.FC<FolderPickerProps> = ({
  id,
  value,
  onChange,
  options,
  label,
  ariaLabel,
  disabled = false,
  placeholder = DEFAULT_PROJECT_FOLDER,
}) => {
  const listId = `${id}-options`;
  // The default folder is a presentation of "no folder", not a real one, so offering it as
  // something to file into would be misleading — clearing the field does that already.
  const offered = options.filter((folder) => folder !== DEFAULT_PROJECT_FOLDER);

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-[11px] text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="text"
        list={listId}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel ?? label}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-border/70 bg-bg-2 px-2 py-1 text-[12px] text-fg"
      />
      <datalist id={listId}>
        {offered.map((folder) => (
          <option key={folder} value={folder} />
        ))}
      </datalist>
    </div>
  );
};

export default FolderPicker;
