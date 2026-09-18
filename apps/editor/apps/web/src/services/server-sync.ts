import type { Project } from "@openreel/core";
import {
  ProjectConflictError,
  loadServerProject,
  saveServerProject,
} from "./server-storage";
import { serializeProjectForAutoSave } from "./auto-save";

/**
 * Keeps the server copy of the open project up to date without anyone pressing save.
 *
 * Deliberately separate from AutoSaveManager rather than bolted onto it. Local autosave
 * is the last-resort safety net and must not be slowed, retried or made noisy by a flaky
 * network, and the two want different cadences: local debounces at 2s, the server is
 * throttled so a long editing session does not become a PUT every two seconds. They
 * share one thing - the dirty signal the project store already emits.
 *
 * What this does NOT do is resolve conflicts. A 409 means something else wrote to this
 * project, and the only thing worse than not saving is overwriting someone's work, so a
 * conflict stops the loop and is handed to the UI.
 */

export type ServerSyncStatus =
  | "idle"
  | "unsaved"
  | "saving"
  | "saved"
  | "conflict"
  | "error";

export interface ServerSyncConflict {
  readonly serverUpdatedAt: number;
  readonly yourUpdatedAt: number;
}

export interface ServerSyncState {
  readonly status: ServerSyncStatus;
  /** When the server last accepted a save for this project. */
  readonly lastSavedAt: number | null;
  /** Set while status is "error"; cleared on the next success. */
  readonly error: string | null;
  /** Set while status is "conflict". */
  readonly conflict: ServerSyncConflict | null;
  /** The `updatedAt` this session last saw, sent as the concurrency guard. */
  readonly expectedUpdatedAt: number | null;
}

export interface ServerSyncConfig {
  /** Quiet period after the last edit before a save is attempted. */
  readonly debounceMs: number;
  /** Smallest gap between two server writes while editing continues. */
  readonly throttleMs: number;
  /** Payload size past which the throttle relaxes, in bytes. */
  readonly largeProjectBytes: number;
  /** Throttle used for projects over that size. */
  readonly largeProjectThrottleMs: number;
  /** First retry delay after a transient failure; doubles up to the cap. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_SERVER_SYNC_CONFIG: ServerSyncConfig = {
  debounceMs: 2000,
  throttleMs: 5000,
  // Measured: real projects serialise to 9-14KB, so this throttle costs a few KB/s. A
  // project two orders of magnitude bigger is a different proposition, and backing off
  // beats hammering the service with megabyte writes.
  largeProjectBytes: 2 * 1024 * 1024,
  largeProjectThrottleMs: 30000,
  retryBaseMs: 2000,
  retryMaxMs: 30000,
};

const IDLE_STATE: ServerSyncState = {
  status: "idle",
  lastSavedAt: null,
  error: null,
  conflict: null,
  expectedUpdatedAt: null,
};

type StateListener = (state: ServerSyncState) => void;

export class ServerSyncManager {
  private config: ServerSyncConfig;
  private state: ServerSyncState = IDLE_STATE;
  private listeners = new Set<StateListener>();

  private pending: Project | null = null;
  private debounceId: ReturnType<typeof setTimeout> | null = null;
  private retryId: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private lastAttemptAt = 0;
  private retryDelay: number;

  /**
   * Hash of the project as the server last accepted it. Doubles as the phantom-conflict
   * test: if a 409's server copy matches this, the newer row is our own earlier write.
   */
  private lastSyncedHash: string | null = null;
  /**
   * Hash of the project when it was opened. Until the project differs from this it is
   * pristine, and a pristine project is not worth creating server-side - otherwise every
   * "New Horizontal Video" tab anyone opens becomes a row in the project list.
   */
  private openedHash: string | null = null;

  constructor(config: Partial<ServerSyncConfig> = {}) {
    this.config = { ...DEFAULT_SERVER_SYNC_CONFIG, ...config };
    this.retryDelay = this.config.retryBaseMs;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): ServerSyncState {
    return this.state;
  }

  /**
   * Starts tracking a project.
   *
   * `serverUpdatedAt` is the row's timestamp when it was opened, or null for a project
   * the server has never seen. Resets every hash and timer, because nothing about the
   * previous project means anything here.
   */
  beginProject(project: Project, serverUpdatedAt: number | null): void {
    this.cancelTimers();
    this.pending = null;
    this.inFlight = false;
    this.lastAttemptAt = 0;
    this.retryDelay = this.config.retryBaseMs;
    this.openedHash = this.hash(project);
    this.lastSyncedHash = serverUpdatedAt !== null ? this.openedHash : null;
    this.setState({
      ...IDLE_STATE,
      expectedUpdatedAt: serverUpdatedAt,
      lastSavedAt: serverUpdatedAt,
    });
  }

  /** Records a save this manager did not perform, such as the manual panel save. */
  noteExternalSave(project: Project, updatedAt: number): void {
    this.lastSyncedHash = this.hash(project);
    this.setState({
      ...this.state,
      status: "saved",
      expectedUpdatedAt: updatedAt,
      lastSavedAt: updatedAt,
      error: null,
      conflict: null,
    });
  }

  /** The project changed. Schedules a save unless one is already due sooner. */
  markDirty(project: Project): void {
    if (this.state.status === "conflict") return;
    this.pending = project;

    if (this.isPristine(project)) return;
    if (this.hash(project) === this.lastSyncedHash) return;

    if (this.state.status !== "saving") {
      this.setState({ ...this.state, status: "unsaved" });
    }
    this.schedule(this.config.debounceMs);
  }

  /**
   * Saves immediately, skipping debounce and throttle. Used by the manual button and by
   * the moments where the tab may be about to go away - hide, blur, unload.
   */
  async flushNow(project?: Project): Promise<void> {
    if (project) this.pending = project;
    if (this.state.status === "conflict") return;
    this.cancelTimers();
    await this.attemptSave();
  }

  /** True when there are edits the server has not accepted yet. */
  hasUnsyncedChanges(): boolean {
    if (!this.pending) return false;
    if (this.isPristine(this.pending)) return false;
    return this.hash(this.pending) !== this.lastSyncedHash;
  }

  /** The payload a last-gasp unload flush would send, or null when nothing is pending. */
  pendingPayload(): {
    project: Project;
    expectedUpdatedAt: number | null;
  } | null {
    if (!this.hasUnsyncedChanges() || !this.pending) return null;
    return {
      project: this.pending,
      expectedUpdatedAt: this.state.expectedUpdatedAt,
    };
  }

  /** Clears a conflict once the user has chosen how to resolve it. */
  clearConflict(expectedUpdatedAt: number | null): void {
    this.retryDelay = this.config.retryBaseMs;
    this.setState({
      ...this.state,
      status: "idle",
      conflict: null,
      error: null,
      expectedUpdatedAt,
    });
  }

  stop(): void {
    this.cancelTimers();
    this.pending = null;
  }

  /* ------------------------------------------------------------- internals */

  private isPristine(project: Project): boolean {
    return this.openedHash !== null && this.hash(project) === this.openedHash;
  }

  private throttleFor(project: Project): number {
    const size = this.serialize(project).length;
    return size > this.config.largeProjectBytes
      ? this.config.largeProjectThrottleMs
      : this.config.throttleMs;
  }

  private schedule(delayMs: number): void {
    if (this.debounceId || this.inFlight) return;

    const project = this.pending;
    const sinceLast = Date.now() - this.lastAttemptAt;
    const throttle = project ? this.throttleFor(project) : this.config.throttleMs;
    // The throttle only ever pushes a save later, never earlier: a burst of edits
    // coalesces into one write instead of one write per debounce window.
    const wait = Math.max(delayMs, throttle - sinceLast);

    this.debounceId = setTimeout(
      () => {
        this.debounceId = null;
        void this.attemptSave();
      },
      Math.max(0, wait),
    );
  }

  private async attemptSave(): Promise<void> {
    if (this.inFlight) return;
    const project = this.pending;
    if (!project) return;
    if (this.isPristine(project)) return;

    const hash = this.hash(project);
    if (hash === this.lastSyncedHash) {
      this.setState({ ...this.state, status: "saved" });
      return;
    }

    this.inFlight = true;
    this.lastAttemptAt = Date.now();
    this.setState({ ...this.state, status: "saving" });

    try {
      // No folder argument: an automatic save must never reset a folder someone chose
      // in the panel, and the route treats an absent folder as "leave it alone".
      const result = await saveServerProject(
        project,
        this.state.expectedUpdatedAt,
      );
      this.lastSyncedHash = hash;
      this.retryDelay = this.config.retryBaseMs;
      this.setState({
        ...this.state,
        status: "saved",
        expectedUpdatedAt: result.updatedAt,
        lastSavedAt: result.updatedAt,
        error: null,
        conflict: null,
      });
    } catch (error) {
      if (error instanceof ProjectConflictError) {
        await this.handleConflict(error, project, hash);
      } else {
        this.handleTransientFailure(error);
      }
    } finally {
      this.inFlight = false;
    }

    // Edits that landed while the request was in flight.
    if (this.state.status !== "conflict" && this.hasUnsyncedChanges()) {
      this.schedule(this.config.debounceMs);
    }
  }

  /**
   * A 409 means the row moved under us. Almost always that is another tab or another
   * machine, and auto-retrying with the server's newer timestamp would overwrite it, so
   * the loop stops and the UI decides.
   *
   * The exception is a phantom: a save of ours that landed but whose response never got
   * applied (a dropped response, a reload mid-flight). If the server's copy is what we
   * last sent, nobody else wrote, and rebasing onto it is safe.
   */
  private async handleConflict(
    error: ProjectConflictError,
    project: Project,
    hash: string,
  ): Promise<void> {
    try {
      const remote = await loadServerProject(project.id);
      if (this.hash(remote.project) === this.lastSyncedHash) {
        this.setState({
          ...this.state,
          expectedUpdatedAt: remote.updatedAt,
          conflict: null,
          error: null,
        });
        this.inFlight = false;
        const retried = await this.retryAfterRebase(project, hash);
        if (retried) return;
      }
    } catch {
      // Could not read the server copy; fall through and treat it as a real conflict.
    }

    this.setState({
      ...this.state,
      status: "conflict",
      conflict: {
        serverUpdatedAt: error.serverUpdatedAt,
        yourUpdatedAt: error.yourUpdatedAt,
      },
      error: null,
    });
  }

  /** One rebased attempt. Returns false if it fails, so the caller reports a conflict. */
  private async retryAfterRebase(
    project: Project,
    hash: string,
  ): Promise<boolean> {
    try {
      const result = await saveServerProject(
        project,
        this.state.expectedUpdatedAt,
      );
      this.lastSyncedHash = hash;
      this.setState({
        ...this.state,
        status: "saved",
        expectedUpdatedAt: result.updatedAt,
        lastSavedAt: result.updatedAt,
        error: null,
        conflict: null,
      });
      return true;
    } catch {
      return false;
    }
  }

  private handleTransientFailure(error: unknown): void {
    const message =
      error instanceof Error ? error.message : "Could not reach the server";
    this.setState({ ...this.state, status: "error", error: message });

    // The edit is still in IndexedDB, so a failure here costs freshness, not work.
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.config.retryMaxMs);
    this.retryId = setTimeout(() => {
      this.retryId = null;
      void this.attemptSave();
    }, delay);
  }

  private cancelTimers(): void {
    if (this.debounceId) {
      clearTimeout(this.debounceId);
      this.debounceId = null;
    }
    if (this.retryId) {
      clearTimeout(this.retryId);
      this.retryId = null;
    }
  }

  private serialize(project: Project): string {
    return serializeProjectForAutoSave(project);
  }

  private hash(project: Project): string {
    const text = this.serialize(project);
    // FNV-1a: this only has to detect change, not resist anything.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${text.length}:${(h >>> 0).toString(16)}`;
  }

  private setState(next: ServerSyncState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

export const serverSyncManager = new ServerSyncManager();
