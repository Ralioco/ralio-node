/** Chat resource — drive an agent with natural language (`agents:execute`). */

import type { Transport } from "../transport.js";
import { parseChatReply, type ChatReply, type ChatStreamEvent } from "../types.js";

export interface ChatParams {
  agentId: string;
  message: string;
  conversationId?: string;
}

export class ChatResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Send a message and wait for the agent's complete reply.
   *
   * Times out server-side after 120s. For interactive approval flows where a
   * human may take longer, use {@link stream} instead.
   */
  async send(params: ChatParams): Promise<ChatReply> {
    const response = await this.transport.request("POST", "/api/chat", {
      jsonBody: body(params),
    });
    return parseChatReply((await response.json()) as Record<string, unknown>);
  }

  /**
   * Stream the agent's reply as server-sent events.
   *
   * Yields `conversation`, `tool_started`/`tool_completed`/`tool_failed`,
   * `text_delta`, and a final `reply` event.
   */
  stream(params: ChatParams): AsyncGenerator<ChatStreamEvent> {
    return this.transport.streamSse("POST", "/api/chat/stream", {
      jsonBody: body(params),
    });
  }
}

function body(params: ChatParams): Record<string, unknown> {
  const out: Record<string, unknown> = {
    agent_id: params.agentId,
    message: params.message,
  };
  if (params.conversationId !== undefined) out.conversation_id = params.conversationId;
  return out;
}
