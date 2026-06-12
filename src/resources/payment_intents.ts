/** Payment intents resource — read agent-created payment requests (`transactions:read`). */

import type { TransportLike } from "../transport.js";
import { parsePage, parsePaymentIntent, type Page, type PaymentIntent } from "../types.js";

export interface ListPaymentIntentsParams {
  agentId?: string;
  page?: number;
  perPage?: number;
}

export class PaymentIntentsResource {
  constructor(private readonly transport: TransportLike) {}

  /**
   * List payment intents across the caller's agents, newest first.
   *
   * Returns one {@link Page} of results (`.data` plus `.total` / `.page` /
   * `.perPage`); pass `page` to walk through further pages.
   */
  async list(params: ListPaymentIntentsParams = {}): Promise<Page<PaymentIntent>> {
    const response = await this.transport.request("GET", "/api/payment-intents", {
      params: {
        page: params.page ?? 1,
        per_page: params.perPage ?? 50,
        agent_id: params.agentId,
      },
    });
    const payload = (await response.json()) as Record<string, unknown>;
    return parsePage(payload, "payment_intents", parsePaymentIntent);
  }
}
