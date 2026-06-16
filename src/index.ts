/** Official TypeScript SDK for the Ralio agentic payment API. */

export {
  RalioClient,
  type RalioClientLocalCredentialOptions,
  type RalioClientOptions,
  type RalioClientStoreOptions,
} from "./client.js";
export { LocalFileCredentialStore } from "./credentials.js";
export { register, DEFAULT_BASE_URL, type RegisterOptions } from "./registration.js";

export type { PrivateJwk, PublicJwk } from "./crypto.js";
export type {
  CredentialStore,
  LocalFileCredentialStoreOptions,
  StoredCredentials,
  WritableCredentialStore,
} from "./credentials.js";
export type {
  Agent,
  ChatReply,
  ChatStreamEvent,
  CredentialBinding,
  Message,
  Page,
  PaymentInstruction,
  PaymentIntent,
  Transaction,
} from "./types.js";
export type {
  ChatParams,
  ListPaymentIntentsParams,
  ListTransactionsParams,
} from "./resources/index.js";

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
