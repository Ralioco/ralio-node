/** Transactions resource — read executed payments (`transactions:read`). */

import type { TransportLike } from "../transport.js";
import { parseTransaction, type Transaction } from "../types.js";

export interface ListTransactionsParams {
  agentId?: string;
  limit?: number;
}

export class TransactionsResource {
  constructor(private readonly transport: TransportLike) {}

  /** List transactions across the caller's agents, newest first. */
  async list(params: ListTransactionsParams = {}): Promise<Transaction[]> {
    const response = await this.transport.request("GET", "/api/transactions", {
      params: { limit: params.limit ?? 50, agent_id: params.agentId },
    });
    const items = (await response.json()) as Record<string, unknown>[];
    return items.map(parseTransaction);
  }
}
