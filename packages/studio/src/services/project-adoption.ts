/**
 * Project-adoption.ts — a late-bound slot for opening a freshly created project in this window.
 *
 * The AI `create_project` tool (services/ai-project-tools.ts) needs to run the full project-open
 * flow (`openRecentProject` in studio.ts), but services must not import studio.ts — the entry
 * module imports the services. studio.ts registers the adopter at boot; the tool calls
 * `adoptProject(root)`.
 *
 * @license MIT
 */

let _adopter: ((root: string) => Promise<void>) | null = null;

/** Register the project-open flow (studio.ts boot). */
export function setProjectAdopter(fn: (root: string) => Promise<void>): void {
  _adopter = fn;
}

/**
 * Open the project at `root` in this window via the registered flow.
 *
 * @param {string} root - Absolute project root.
 */
export async function adoptProject(root: string): Promise<void> {
  if (!_adopter) {
    throw new Error(
      "Project adoption is not available in this environment — open the project manually from the welcome screen.",
    );
  }
  await _adopter(root);
}
