/** Chat resource — drive an agent with natural language (`agents:execute`). */

import { RalioConfigError } from "../errors.js";
import type { Transport } from "../transport.js";
import { parseChatReply, type ChatReply, type ChatStreamEvent } from "../types.js";
import type { AgentsResource } from "./agents.js";

export interface ChatParams {
  /**
   * The agent to address. Optional: when omitted, the SDK resolves the single
   * agent your credential is bound to (looked up once via `agents.list()` and
   * cached). Pass it explicitly only if the credential can reach more than one
   * agent.
   */
  agentId?: string;
  message: string;
  conversationId?: string;
}

interface ResolvedChatParams {
  agentId: string;
  message: string;
  conversationId?: string;
}

export class ChatResource {
  private cachedAgentId?: string;

  constructor(
    private readonly transport: Transport,
    private readonly agents: AgentsResource,
  ) {}

  /**
   * Send a message and wait for the agent's complete reply.
   *
   * Times out server-side after 120s. For interactive approval flows where a
   * human may take longer, use {@link stream} instead.
   */
  async send(params: ChatParams): Promise<ChatReply> {
    const agentId = await this.resolveAgentId(params.agentId);
    const response = await this.transport.request("POST", "/api/chat", {
      jsonBody: body({ ...params, agentId }),
    });
    return parseChatReply((await response.json()) as Record<string, unknown>);
  }

  /**
   * Stream the agent's reply as server-sent events.
   *
   * Yields `conversation`, `tool_started`/`tool_completed`/`tool_failed`,
   * `text_delta`, and a final `reply` event.
   */
  async *stream(params: ChatParams): AsyncGenerator<ChatStreamEvent> {
    const agentId = await this.resolveAgentId(params.agentId);
    yield* this.transport.streamSse("POST", "/api/chat/stream", {
      jsonBody: body({ ...params, agentId }),
    });
  }

  /**
   * Resolve which agent to address: the explicit `agentId` if provided, else
   * the single agent this credential is bound to (cached after first lookup).
   */
  private async resolveAgentId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    if (this.cachedAgentId) return this.cachedAgentId;

    const agents = await this.agents.list();
    if (agents.length === 0) {
      throw new RalioConfigError(
        "No agent is bound to this credential; pass agentId to chat explicitly.",
      );
    }
    if (agents.length > 1) {
      throw new RalioConfigError(
        `This credential can reach ${agents.length} agents; pass agentId to chat explicitly.`,
      );
    }
    this.cachedAgentId = agents[0]!.id;
    return this.cachedAgentId;
  }
}

function body(params: ResolvedChatParams): Record<string, unknown> {
  const out: Record<string, unknown> = {
    agent_id: params.agentId,
    message: params.message,
  };
  if (params.conversationId !== undefined) out.conversation_id = params.conversationId;
  return out;
}
