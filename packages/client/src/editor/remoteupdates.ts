import * as Y from 'yjs';
import { PendingMoves } from '@overlyx/core/pendingmoves.ts';

/** Remote content waits for outstanding local moves to become canonical, while
 * retaining each packet's undo origin and dependency order. A flush is one
 * synchronous task, so no intermediate document can be painted or edited. */
export class RemoteUpdates {
  private packets: { update: Uint8Array; origin: unknown }[] = [];

  constructor(private readonly doc: Y.Doc, private readonly moves: PendingMoves,
    private readonly remoteOrigin: unknown, private readonly agentOrigin: unknown,
    private readonly beforeApply: () => void = () => {}) {}

  receive(update: Uint8Array): boolean {
    if (this.moves.waiting || this.packets.length) this.packets.push({ update, origin: this.remoteOrigin });
    const ready = this.moves.receive(update);
    if (!ready) return false;
    this.beforeApply();
    if (this.packets.length) {
      // Separate transactions are required: a surrounding Y.transact would
      // replace the agent's tracked origin with the enclosing remote origin.
      for (const packet of this.packets) Y.applyUpdate(this.doc, packet.update, packet.origin);
      this.packets = [];
    } else Y.applyUpdate(this.doc, ready, this.remoteOrigin);
    return true;
  }

  receiveAgent(update: Uint8Array): void {
    if (this.moves.waiting || this.packets.length) { this.packets.push({ update, origin: this.agentOrigin }); return; }
    this.beforeApply();
    Y.applyUpdate(this.doc, update, this.agentOrigin);
  }

  destroy(): void { this.packets = []; }
}
