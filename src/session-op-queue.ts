export type PromptOp = {
  type: "prompt";
  content: string;
};

export type InterruptOp = {
  type: "interrupt" | "stop_task";
  reason: string;
  requestId?: string;
  emitControlResponse: boolean;
};

export type PermissionResponseOp = {
  type: "permission_response";
  behavior: "allow" | "deny";
  requestId: string;
};

export type SlashCommandOp = {
  type: "slash_command";
  command: string;
};

export type ControlOp = InterruptOp | PermissionResponseOp;
export type NormalOp = PromptOp | SlashCommandOp;
export type SessionOp = ControlOp | NormalOp;

/**
 * Priority queue for session operations. Interrupt-like controls are kept in a
 * priority lane so they can stop the active turn without waiting behind queued
 * prompts.
 */
export class SessionOpQueue {
  private normal: NormalOp[] = [];
  private controls: ControlOp[] = [];
  private waitResolvers: Array<() => void> = [];
  private closed = false;

  enqueue(op: SessionOp): void {
    if (this.closed) return;
    if (op.type === "prompt" || op.type === "slash_command") {
      this.normal.push(op);
    } else {
      this.controls.push(op);
    }
    this.wakeAll();
  }

  dequeueControl(): ControlOp | undefined {
    return this.controls.shift();
  }

  dequeueNormal(): NormalOp | undefined {
    return this.normal.shift();
  }

  get length(): number {
    return this.controls.length + this.normal.length;
  }

  get normalLength(): number {
    return this.normal.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  waitForChange(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise(resolve => { this.waitResolvers.push(resolve); });
  }

  wake(): void {
    this.wakeAll();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakeAll();
  }

  private wakeAll(): void {
    const resolvers = this.waitResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}
