/** Official TypeScript SDK for the Ralio agentic payment API. */

export { RalioClient, type RalioClientOptions } from "./client.js";
export { register, DEFAULT_BASE_URL, type RegisterOptions } from "./registration.js";

export type {
  ChatReply,
  ChatStreamEvent,
  CredentialBinding,
  Message,
  Transaction,
} from "./types.js";
export type { ChatParams, ListTransactionsParams } from "./resources/index.js";

export {
  RalioError,
  RalioConfigError,
  RalioRegistrationError,
  RalioAPIError,
  RalioAuthError,
  RalioPermissionError,
  RalioNotFoundError,
  RalioValidationError,
  RalioRateLimitError,
} from "./errors.js";
