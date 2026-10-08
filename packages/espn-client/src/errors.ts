export class EspnError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401/403: missing or expired cookies. Re-copy `espn_s2` from the browser. */
export class EspnAuthError extends EspnError {}

/** 404: wrong league id or season. */
export class EspnNotFoundError extends EspnError {}

/** Any other non-200, a network failure, or a response that isn't JSON. */
export class EspnHttpError extends EspnError {}
