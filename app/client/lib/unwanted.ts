/**
 * Local "不要" (unwanted) marks — per device, never shared.
 *
 * Marking a file unwanted means it won't be downloaded to THIS device (Phase 2
 * auto-download will skip it) and it renders dimmed. Persisted in localStorage
 * so it survives reloads. Scoped per room so marks don't bleed across albums.
 */

const KEY_PREFIX = "photorrent:unwanted:";

function load(roomId: string): Set<string> {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + roomId);
    return new Set(raw ? JSON.parse(raw) as string[] : []);
  } catch {
    return new Set();
  }
}

function save(roomId: string, set: Set<string>): void {
  try {
    localStorage.setItem(KEY_PREFIX + roomId, JSON.stringify([...set]));
  } catch {
    // Storage full / disabled — marks just won't persist this session.
  }
}

/** In-memory + persisted set of unwanted file ids for one room. */
export class UnwantedSet {
  private set: Set<string>;

  constructor(private roomId: string) {
    this.set = load(roomId);
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  /** Flip a file's unwanted state; returns the new state. */
  toggle(id: string): boolean {
    if (this.set.has(id)) this.set.delete(id);
    else this.set.add(id);
    save(this.roomId, this.set);
    return this.set.has(id);
  }
}
