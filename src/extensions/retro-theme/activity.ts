/**
 * Activity tracker — generation-phase feedback for the footer.
 *
 * Long model turns previously showed only a spinning "Working..." row with
 * no signal about what phase the agent was in (thinking / streaming / tool
 * execution) or how long it had been there. This tracker converts pi's
 * lifecycle events into a status message pushed through
 * `ui.setWorkingMessage()`, which the streaming row re-renders on its own
 * animation tick — no extra render plumbing needed.
 */
export type ActivityPhase = "idle" | "thinking" | "streaming" | "tool";

export interface ActivityClock {
  now: () => number;
}

const TICK_MS = 1000;
/** Tool names longer than this are truncated in the working row (2.1.7). */
const TOOL_NAME_MAX = 24;

/** 112 → "1m52s", 3661 → "1h1m1s"; whole units omit the zero tail. */
export function formatDuration(elapsedSeconds: number): string {
  const seconds = Math.max(0, Math.round(elapsedSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    if (minutes > 0) return secs > 0 ? `${hours}h${minutes}m${secs}s` : `${hours}h${minutes}m`;
    return secs > 0 ? `${hours}h${secs}s` : `${hours}h`;
  }
  if (minutes > 0) return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

export class ActivityTracker {
  private phase: ActivityPhase = "idle";
  private startedAt = 0;
  private toolName = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private setWorkingMessage: ((message?: string) => void) | null = null;
  private readonly now: () => number;

  constructor(clock: ActivityClock = { now: Date.now }) {
    this.now = clock.now;
  }

  /** Bind the UI sink. */
  attach(setWorkingMessage: (message?: string) => void): void {
    this.setWorkingMessage = setWorkingMessage;
  }

  beginThinking(): void {
    this.setPhase("thinking");
  }

  /** First streamed content token arrives. */
  beginStreaming(): void {
    if (this.phase === "thinking") this.setPhase("streaming");
  }

  beginTool(name: string): void {
    this.toolName = name;
    this.setPhase("tool");
  }

  endTool(): void {
    this.beginThinking();
  }

  finish(): void {
    this.setPhase("idle");
  }

  getPhase(): ActivityPhase {
    return this.phase;
  }

  getToolName(): string {
    return this.toolName;
  }

  formatStatus(): string | undefined {
    const elapsed = Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
    switch (this.phase) {
      case "thinking":
        return `thinking ${formatDuration(elapsed)}`;
      case "streaming":
        return `streaming ${formatDuration(elapsed)}`;
      case "tool": {
        // 2.1.7: `typescript-language-server` etc. used to overflow the row
        // and wrap — clip the name to a fixed width.
        const name = this.toolName.length > TOOL_NAME_MAX
          ? `${this.toolName.slice(0, TOOL_NAME_MAX - 1)}…`
          : this.toolName;
        return `tool ${name} ${formatDuration(elapsed)}`;
      }
      case "idle":
        return undefined;
    }
  }

  private setPhase(phase: ActivityPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.startedAt = this.now();
    if (phase === "idle") {
      this.stopTimer();
      this.setWorkingMessage?.();
      return;
    }
    this.startTimer();
    this.push();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.push(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private push(): void {
    this.setWorkingMessage?.(this.formatStatus());
  }

  /** Test hook: drop the timer and sink without touching phase. */
  __resetForTests(): void {
    this.stopTimer();
    this.setWorkingMessage = null;
  }
}
