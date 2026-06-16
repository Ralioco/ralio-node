/** Exception hierarchy for the Ralio SDK. */

/** Base class for every error raised by the SDK. */
export class RalioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Local configuration problem — missing key, bad arguments. */
export class RalioConfigError extends RalioError {}

/**
 * A credential-binding registration failed — the ticket was invalid, expired,
 * or already consumed, the public key was unusable, or the server's response
 * didn't match the local key.
 */
export class RalioRegistrationError extends RalioError {}

/**
 * An error response from the Ralio API.
 *
 * Carries the HTTP `statusCode`, the server-supplied `detail` string, and the
 * `WWW-Authenticate` challenge when present (DPoP/OAuth failures put the
 * specific reason there).
 */
export class RalioAPIError extends RalioError {
  readonly statusCode: number;
  readonly detail: string | null;
  readonly wwwAuthenticate: string | null;

  constructor(
    message: string,
    opts: { statusCode: number; detail?: string | null; wwwAuthenticate?: string | null },
  ) {
    super(message);
    this.statusCode = opts.statusCode;
    this.detail = opts.detail ?? null;
    this.wwwAuthenticate = opts.wwwAuthenticate ?? null;
  }
}

/** 401 — missing/invalid token, failed client assertion, or rejected proof. */
export class RalioAuthError extends RalioAPIError {}

/** 403 — token lacks the required scope, or the resource isn't owned. */
export class RalioPermissionError extends RalioAPIError {}

/** 404 — resource does not exist. */
export class RalioNotFoundError extends RalioAPIError {}

/** 422 — invalid field values or a business-rule violation. */
export class RalioValidationError extends RalioAPIError {}

/** 429 — rate limited. Back off and retry. */
export class RalioRateLimitError extends RalioAPIError {}

const STATUS_MAP: Record<
  number,
  new (m: string, o: ConstructorParameters<typeof RalioAPIError>[1]) => RalioAPIError
> = {
  401: RalioAuthError,
  403: RalioPermissionError,
  404: RalioNotFoundError,
  422: RalioValidationError,
  429: RalioRateLimitError,
};

/** Throw the appropriate {@link RalioAPIError} if `response` is an error. */
export async function raiseForResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const detail = await extractDetail(response);
  const Cls = STATUS_MAP[response.status] ?? RalioAPIError;
  const message = detail ?? `HTTP ${response.status}`;
  throw new Cls(message, {
    statusCode: response.status,
    detail,
    wwwAuthenticate: response.headers.get("www-authenticate"),
  });
}

/** Return the FastAPI `detail` field, or the raw body as a fallback. */
async function extractDetail(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text || null;
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    if (obj.detail != null) return JSON.stringify(obj.detail);
    // OAuth-style error bodies use error/error_description instead.
    const oauth = obj.error_description ?? obj.error;
    if (typeof oauth === "string") return oauth;
  }
  return text || null;
}
