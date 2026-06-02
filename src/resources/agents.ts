/** Agents resource — read the agents this credential can address (read-only). */

import type { Transport } from "../transport.js";
import { parseAgent, type Agent } from "../types.js";

export class AgentsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * List the agents the caller can address.
   *
   * For a credential binding this is exactly the one agent the binding is
   * pinned to — the gateway filters the result to the bound agent. (A human
   * JWT caller would see all of its agents, but this SDK is machine-only.)
   */
  async list(): Promise<Agent[]> {
    const response = await this.transport.request("GET", "/api/agents");
    const items = (await response.json()) as Record<string, unknown>[];
    return items.map(parseAgent);
  }
}
