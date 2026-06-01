// Global preload for studio tests that need DOM.
// Registers HappyDOM before any test modules are loaded so module-level
// document references (e.g., slash-menu.js creating its host div) work.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
export {};
