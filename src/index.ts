/** Official TypeScript SDK for the Ralio agentic payment API. */

export { RalioClient, type RalioClientOptions } from "./client.js";
export { register, DEFAULT_BASE_URL, type RegisterOptions } from "./registration.js";

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
