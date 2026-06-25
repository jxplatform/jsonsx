/**
 * Type declarations for ai-settings.js (Studio is `allowJs: false`, so the `.ts` panel needs
 * explicit types for this `.js` module). Keep in sync with `ai-settings.js`.
 */

export function getOpenAiKey(): string;
export function setOpenAiKey(key: string): void;
export function hasOpenAiKey(): boolean;
export function getBaseUrl(): string;
export function setBaseUrl(url: string): void;
export function getModel(): string;
export function setModel(modelId: string): void;
