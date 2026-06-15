/**
 * Type declarations for document-assistant.js (Studio is `allowJs: false`, so the `.ts` panel needs
 * explicit types for this `.js` module). Keep in sync with `document-assistant.js`.
 */

import type { createChatState } from "@jxsuite/ai/chat-state";

export interface DocumentAssistant {
  chatState: ReturnType<typeof createChatState>;
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  newChat: () => void;
}

/** Create a document-assistant session bound to the currently active tab. */
export function createDocumentAssistant(): DocumentAssistant;
