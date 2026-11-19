/** A request the relayer will not carry out. `code` is for the page; `extra` may carry the contract's reason by name. */
export class Refused extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.name = "Refused";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
