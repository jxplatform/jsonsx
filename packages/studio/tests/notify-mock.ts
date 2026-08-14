/**
 * One `mock.module` factory for `services/notify.ts`, for the tests that want to assert on the
 * SENTENCE a module reports rather than on the store it lands in.
 *
 * It spreads the real module and overrides only `notify`, which matters: `panels/statusbar.ts`
 * imports `problems` and `problemCount` from the same module, so a factory that returned four
 * functions and nothing else would break every importer in the graph — the failure mode that made
 * this helper worth writing down once.
 *
 * Prefer the real store where you can (`toasts`, `problems`, `resetNotifications`); reach for this
 * only when the module under test is mocked at the boundary anyway.
 */
import * as real from "../src/services/notify";
import type { NotifyOptions, Severity } from "../src/services/notify";

/** What a recorder is handed for each reported outcome. */
export interface NotifyCall {
  severity: Severity;
  message: string;
  options: NotifyOptions;
}

/**
 * Build the module object. `record` is called once per notification, in call order.
 *
 * @example
 *   const calls: NotifyCall[] = [];
 *   void mock.module("../src/services/notify.js", () => notifyModule((c) => calls.push(c)));
 */
export function notifyModule(record: (call: NotifyCall) => void): typeof real {
  const emit =
    (severity: Severity) =>
    (message: string, options: NotifyOptions = {}) => {
      record({ message, options, severity });
      return { at: 0, id: "mock", message, severity, tier: "toast" as const };
    };
  const notify = Object.assign(
    (severity: Severity, message: string, options: NotifyOptions = {}) =>
      emit(severity)(message, options),
    { error: emit("error"), info: emit("info"), success: emit("success"), warn: emit("warn") },
  );
  return { ...real, notify } as unknown as typeof real;
}
