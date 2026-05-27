/**
 * Response types returned by the SDK.
 *
 * Parsing is forgiving: unknown fields the API may add later are ignored, so a
 * server-side addition never breaks a pinned client.
 */

type Json = Record<string, unknown>;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The result of a completed registration. `clientId` is the `cb_…` handle used
 * to mint tokens; the private key lives on disk.
 */
export interface CredentialBinding {
  clientId: string;
  scopes: string[];
}

export interface Message {
  id: string;
  role: string;
  content: string;
  createdAt: string | null;
}

export function parseMessage(data: Json): Message {
  return {
    id: str(data.id),
    role: str(data.role),
    content: str(data.content),
    createdAt: optStr(data.created_at),
  };
}

/** A synchronous `chat.send` response. */
export interface ChatReply {
  reply: string;
  conversationId: string;
  newMessages: Message[];
}

export function parseChatReply(data: Json): ChatReply {
  const raw = Array.isArray(data.new_messages) ? data.new_messages : [];
  return {
    reply: str(data.reply),
    conversationId: str(data.conversation_id),
    newMessages: raw.map((m) => parseMessage((m ?? {}) as Json)),
  };
}

/**
 * One server-sent event from `chat.stream`.
 *
 * `event` is the SSE event name (`conversation`, `tool_started`,
 * `tool_completed`, `tool_failed`, `text_delta`, `reply`, `error`); `data` is
 * the decoded JSON payload. `text` is a convenience for the common
 * `text_delta` / `reply` case (empty string when absent).
 */
export interface ChatStreamEvent {
  event: string;
  data: Json;
  text: string;
}

export function buildStreamEvent(event: string, data: Json): ChatStreamEvent {
  return { event, data, text: typeof data.text === "string" ? data.text : "" };
}

export interface Transaction {
  id: string;
  amount: string;
  currency: string;
  status: string;
  date: string | null;
  creditor: string | null;
  debtor: string | null;
  reference: string | null;
  paymentIntentId: string | null;
}

export function parseTransaction(data: Json): Transaction {
  return {
    id: str(data.id),
    amount: str(data.amount),
    currency: str(data.currency),
    status: str(data.status),
    date: optStr(data.date),
    creditor: optStr(data.creditor),
    debtor: optStr(data.debtor),
    reference: optStr(data.reference),
    paymentIntentId: optStr(data.payment_intent_id),
  };
}
