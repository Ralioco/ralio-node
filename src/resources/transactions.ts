/** Transactions resource — read executed payments (`transactions:read`). */

import type { TransportLike } from "../transport.js";
import { parsePage, parseTransaction, type Page, type Transaction } from "../types.js";

export interface ListTransactionsParams {
  agentId?: string;
  page?: number;
  perPage?: number;
}

export class TransactionsResource {
  constructor(private readonly transport: TransportLike) {}

  /**
   * List transactions across the caller's agents, newest first.
   *
   * Returns one {@link Page} of results (`.data` plus `.total` / `.page` /
   * `.perPage`); pass `page` to walk through further pages.
   */
  async list(params: ListTransactionsParams = {}): Promise<Page<Transaction>> {
    const response = await this.transport.request("GET", "/api/transactions", {
      params: {
        page: params.page ?? 1,
        per_page: params.perPage ?? 50,
        agent_id: params.agentId,
      },
    });
    const payload = (await response.json()) as Record<string, unknown>;
    return parsePage(payload, "transactions", parseTransaction);
  }
}
