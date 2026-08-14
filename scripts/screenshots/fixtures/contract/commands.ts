/**
 * A command projection for the `scripts/check-shot-contract.ts` fixtures.
 *
 * Loaded with `--commands`, never by the app. It exists to declare the two things the shipped
 * projection does not declare YET, so the rules that depend on them are tested rather than merely
 * written:
 *
 * - `args` JSON Schemas (§13.3 requires one on every scriptable command; `commands/defaults.ts`
 *   declares none today, so the schema rule is inert against the real manifest and would rot);
 * - `isScriptable: false`, the projection refusal §13.5 names.
 *
 * `view.setActivity`'s `tab` carries `declaredBy: "the panel registry"`, which is what makes the
 * §13.5 error string read verbatim as the plan writes it when P3 renames `head` → `page`.
 */

/** The subset of a command record this check reads. Deliberately not `AnyCommand`. */
export interface FixtureCommand {
  id: string;
  args?: object;
  isScriptable?: boolean;
}

export function defaultCommandSet(): FixtureCommand[] {
  return [
    {
      id: "view.setActivity",
      args: {
        type: "object",
        additionalProperties: false,
        required: ["tab"],
        properties: {
          tab: { type: "string", enum: ["page"], declaredBy: "the panel registry" },
        },
      },
    },
    {
      id: "view.setAssistant",
      args: {
        type: "object",
        additionalProperties: false,
        required: ["open"],
        properties: { open: { type: "boolean" } },
      },
    },
    {
      id: "canvas.setZoom",
      args: {
        type: "object",
        additionalProperties: false,
        required: ["zoom"],
        properties: { zoom: { type: "number" } },
      },
    },
    {
      id: "file.open",
      args: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    { id: "view.showPanel", args: { type: "object", properties: {} } },
    { id: "seed.git" },
    // Present in the registry, refused by the `run()` projection: §13.3 clause 2 deletes
    // `setStatus`, and a shot must fail loudly rather than stage the word "Ready".
    { id: "view.setStatus", isScriptable: false },
  ];
}
