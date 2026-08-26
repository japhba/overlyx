/**
 * A LaTeX output stream that mimics LyX's `otexstream`: it knows the last
 * character written, whether a line break may be inserted, and implements the
 * "terminate command" logic that adds `{}` or a space after commands such as
 * `\LyX` depending on what follows.
 */
export class TexStream {
  private chunks: string[] = [];
  private lastChar = '\0';
  private canBreak = false;
  private parbreak = true;
  private protectSpaceFlag = false;
  private terminateFlag = false;
  /** Characters since the last newline (approximate column, used for wrapping). */
  column = 0;
  /** Total number of newlines written (used to detect multi-line inset output). */
  newlines = 0;

  get afterParbreak(): boolean { return this.parbreak; }
  get canBreakLine(): boolean { return this.canBreak; }
  get last(): string { return this.lastChar; }
  get pendingTermination(): boolean { return this.terminateFlag; }

  private track(c: string): void {
    this.parbreak = !this.canBreak && c === '\n';
    this.canBreak = c !== '\n';
    this.lastChar = c;
    if (c === '\n') { this.column = 0; this.newlines++; } else this.column++;
  }

  private raw(s: string): void {
    if (!s) return;
    this.chunks.push(s);
    for (const c of s) this.track(c);
  }

  /** Write text, honouring pending space protection / command termination. */
  write(s: string): void {
    if (!s) return;
    const c = s[0];
    let isProtected = false;
    if (this.protectSpaceFlag) {
      if (!this.canBreak && c === ' ') { this.raw('{}'); isProtected = true; }
      this.protectSpaceFlag = false;
    }
    if (this.terminateFlag) {
      if ((c === ' ' || c === '\0' || c === '\n') && !isProtected) this.raw('{}');
      else if (c !== '\\' && c !== '{' && c !== '}') this.raw(' ');
      this.terminateFlag = false;
    }
    this.raw(s);
  }

  /** Request termination of the previous command (`\cmd` → `\cmd{}` or `\cmd `). */
  termcmd(): void { this.terminateFlag = true; }

  /** Protect a following space with `{}` (used after inline environments). */
  protectSpace(on = true): void { this.protectSpaceFlag = on; }

  /** Newline unless we are at the start of a line. */
  breakln(): void {
    if (this.canBreak) {
      if (this.terminateFlag) this.raw('{}');
      this.raw('\n');
    }
    this.protectSpaceFlag = false;
    this.terminateFlag = false;
  }

  /** `%\n` unless we are at the start of a line. */
  safebreakln(): void {
    if (this.canBreak) {
      if (this.terminateFlag) this.raw('{}');
      this.raw('%\n');
    }
    this.protectSpaceFlag = false;
    this.terminateFlag = false;
  }

  /** Force a pending termination now (e.g. before closing a group we generate ourselves). */
  flushTermination(): void {
    if (this.terminateFlag) { this.raw('{}'); this.terminateFlag = false; }
  }

  toString(): string {
    return this.chunks.join('');
  }
}
