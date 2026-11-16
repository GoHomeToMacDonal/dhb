/**
 * Input shapes for `dhb tokens`.
 *
 * - `text`: the raw input string is tokenized as-is, with no special tokens
 *   added.
 * - `chat`: the input must be JSON describing a conversation. The model's chat
 *   template is applied before counting, so the result includes role markers,
 *   BOS and the trailing assistant generation prompt, the way an API request
 *   is billed.
 */

/** A single chat message. Extra fields are preserved for chat templates. */
export interface ChatMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export type TokenInput = { kind: "text"; text: string } | { kind: "chat"; messages: ChatMessage[] };

/** Raised when chat input is not valid JSON or not a valid conversation. */
export class ChatInputError extends Error {
  override name = "ChatInputError";
}

/**
 * Parse chat-mode input. Accepts either a bare array of messages or an object
 * with a `messages` array (the OpenAI chat-completions request shape). Each
 * message needs a non-empty string `role` and a string `content`.
 */
export function parseChatInput(raw: string): ChatMessage[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ChatInputError(`chat input must be JSON: ${reason}`);
  }

  const list = Array.isArray(data) ? data : isRecord(data) ? data.messages : undefined;
  if (!Array.isArray(list)) {
    throw new ChatInputError(
      'chat input must be a JSON array of messages or an object with a "messages" array',
    );
  }
  if (list.length === 0) {
    throw new ChatInputError("chat input contains no messages");
  }

  return list.map((message, index) => {
    if (!isRecord(message)) {
      throw new ChatInputError(`messages[${index}] must be an object`);
    }
    if (typeof message.role !== "string" || message.role.length === 0) {
      throw new ChatInputError(`messages[${index}].role must be a non-empty string`);
    }
    if (typeof message.content !== "string") {
      throw new ChatInputError(`messages[${index}].content must be a string`);
    }
    return { ...message, role: message.role, content: message.content };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
