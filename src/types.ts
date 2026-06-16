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

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/**
 * The result of a completed registration. `clientId` is the `cb_…` handle used
 * to mint tokens; the private key lives on disk at `keyPath`.
 */
export interface CredentialBinding {
  clientId: string;
  scopes: string[];
  keyPath: string;
}

/** A payment agent the caller can address. */
export interface Agent {
  id: string;
  name: string;
  agentNumber: number | null;
  bankingProvider: string | null;
  createdAt: string | null;
}

export function parseAgent(data: Json): Agent {
  return {
    id: str(data.id),
    name: str(data.name),
    agentNumber: typeof data.agent_number === "number" ? data.agent_number : null,
    bankingProvider: optStr(data.banking_provider),
    createdAt: optStr(data.created_at),
  };
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

/** One payment leg of an intent (payee + the matched transaction's state). */
export interface PaymentInstruction {
  amount: string;
  currency: string;
  status: string;
  idempotencyKey: string | null;
  creditorAccount: string | null;
  creditorName: string | null;
  debtorAccount: string | null;
  debtorName: string | null;
  reference: string | null;
  transactionId: string | null;
  transactionStatus: string | null;
  executionError: string | null;
}

export function parsePaymentInstruction(data: Json): PaymentInstruction {
  return {
    amount: str(data.amount),
    currency: str(data.currency),
    status: str(data.status),
    idempotencyKey: optStr(data.idempotency_key),
    creditorAccount: optStr(data.creditor_account),
    creditorName: optStr(data.creditor_name),
    debtorAccount: optStr(data.debtor_account),
    debtorName: optStr(data.debtor_name),
    reference: optStr(data.reference),
    transactionId: optStr(data.transaction_id),
    transactionStatus: optStr(data.transaction_status),
    executionError: optStr(data.execution_error),
  };
}

/**
 * A payment request created by an agent, with its per-leg breakdown.
 * `approvalStatus` and `executionStatus` are the two status axes; the headline
 * `totalAmount`/`currency` summarise the whole intent.
 */
export interface PaymentIntent {
  id: string;
  agentId: string;
  approvalStatus: string;
  executionStatus: string;
  totalAmount: string;
  currency: string;
  instructionCount: number;
  instructions: PaymentInstruction[];
  agentName: string | null;
  conversationId: string | null;
  createdAt: string | null;
  userRequestSummary: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  alignmentOutcome: string | null;
}

export function parsePaymentIntent(data: Json): PaymentIntent {
  const rawInstructions = Array.isArray(data.instructions) ? data.instructions : [];
  return {
    id: str(data.id),
    agentId: str(data.agent_id),
    approvalStatus: str(data.approval_status),
    executionStatus: str(data.execution_status),
    totalAmount: str(data.total_amount),
    currency: str(data.currency),
    instructionCount: num(data.instruction_count, rawInstructions.length),
    instructions: rawInstructions.map((i) => parsePaymentInstruction((i ?? {}) as Json)),
    agentName: optStr(data.agent_name),
    conversationId: optStr(data.conversation_id),
    createdAt: optStr(data.created_at),
    userRequestSummary: optStr(data.user_request_summary),
    decisionReason: optStr(data.decision_reason),
    decidedAt: optStr(data.decided_at),
    alignmentOutcome: optStr(data.alignment_outcome),
  };
}

/**
 * One page of a list endpoint plus the unpaginated `total`. `data` holds the
 * rows on this page; `total` is the count across every page.
 */
export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
}

export function parsePage<T>(payload: Json, key: string, parseItem: (item: Json) => T): Page<T> {
  const rows = Array.isArray(payload[key]) ? (payload[key] as Json[]) : [];
  return {
    data: rows.map((row) => parseItem((row ?? {}) as Json)),
    total: num(payload.total, rows.length),
    page: num(payload.page, 1),
    perPage: num(payload.per_page, rows.length),
  };
}
