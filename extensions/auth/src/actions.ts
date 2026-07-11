/**
 * Actions — the `AuthActions` state class: form-friendly sign-in/sign-up/sign-out handlers.
 *
 * `resolve()` returns `{ signInEmail, signUpEmail, signInSocial, signOut }`; each handler is
 * `(scope, event)`-callable — the same shape the connector's table actions use — reading the
 * submitting form's FormData, calling the Better Auth client, refreshing the session store, and
 * applying the configured redirects. Successful calls also bump `scope._v`, re-running lowered
 * table queries whose visible rows may change with the auth state (owner-scoped reads). Wire via
 * `"onsubmit": { "$ref": "auth.signInEmail" }` on a form with email/password fields.
 */

import { getAuthClient } from "./client.ts";
import { clearSession, fetchSession } from "./session.ts";
import type { AuthClientResult } from "./client.ts";

/** Redirect paths applied after auth state changes. */
export interface AuthRedirects {
  afterSignIn?: string;
  afterSignOut?: string;
}

/** Config of the AuthActions state class. */
export interface AuthActionsConfig {
  redirects?: AuthRedirects;
  /** Default social provider id for signInSocial (a form field named "provider" overrides). */
  provider?: string;
  baseUrl?: string;
  /** Injected by hosts (compiler/dev server): the project sections, including `auth`. */
  _project?: { auth?: { redirects?: AuthRedirects }; [key: string]: unknown };
  [key: string]: unknown;
}

type Scope = Record<string, unknown>;

/** A `(scope, event)`-callable auth handler resolving true when the call succeeded. */
export type AuthActionHandler = (scope: Scope, event?: Event) => Promise<boolean>;

/** The submitting form: the event target itself, or the target control's owner form. */
function formOf(event?: Event): HTMLFormElement | null {
  const target = event?.target as (HTMLElement & { form?: HTMLFormElement | null }) | null;
  if (!target) {
    return null;
  }
  return target.tagName === "FORM" ? (target as HTMLFormElement) : (target.form ?? null);
}

/** String field values of the submitting form (files are ignored). */
function formValues(event?: Event): Record<string, string> {
  const form = formOf(event);
  if (!form) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new FormData(form)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/** Navigate to a redirect path when one is configured (browser only). */
function navigate(path: string | undefined): void {
  if (path && typeof location !== "undefined") {
    location.assign(path);
  }
}

/** Bump the read-after-write version so owner-scoped queries re-run under the new session. */
function bumpVersion(scope: Scope): void {
  scope._v = ((scope._v as number) || 0) + 1;
}

export class AuthActions {
  config: AuthActionsConfig;

  constructor(config: AuthActionsConfig = {}) {
    this.config = config;
  }

  /** Effective redirects: the def's own, else the project auth section's. */
  redirects(): AuthRedirects {
    return this.config.redirects ?? this.config._project?.auth?.redirects ?? {};
  }

  /** The handler map, wired via $ref (e.g. `onsubmit: { "$ref": "auth.signInEmail" }`). */
  resolve(): Record<string, AuthActionHandler> {
    return {
      signInEmail: this.#authCall((values, client) =>
        client.signIn.email({ email: values.email ?? "", password: values.password ?? "" }),
      ),
      signInSocial: this.#authCall(
        (values, client) => {
          const provider = values.provider ?? this.config.provider ?? "";
          const callbackURL = this.redirects().afterSignIn;
          return client.signIn.social({
            provider,
            ...(callbackURL === undefined ? {} : { callbackURL }),
          });
          // Social sign-in redirects the whole page itself — no local navigation.
        },
        { redirect: false },
      ),
      signOut: async (scope: Scope, event?: Event): Promise<boolean> => {
        event?.preventDefault?.();
        const { error } = await getAuthClient(this.config.baseUrl).signOut();
        if (error) {
          return false;
        }
        clearSession();
        bumpVersion(scope);
        navigate(this.redirects().afterSignOut);
        return true;
      },
      signUpEmail: this.#authCall((values, client) =>
        client.signUp.email({
          email: values.email ?? "",
          // Better Auth requires a name; fall back to the email's local part.
          name: values.name ?? (values.email ?? "").split("@")[0] ?? "",
          password: values.password ?? "",
        }),
      ),
    };
  }

  /** Build a form-reading handler around one auth client call. */
  #authCall(
    call: (
      values: Record<string, string>,
      client: ReturnType<typeof getAuthClient>,
    ) => Promise<AuthClientResult>,
    options: { redirect?: boolean } = {},
  ): AuthActionHandler {
    return async (scope: Scope, event?: Event): Promise<boolean> => {
      event?.preventDefault?.();
      const client = getAuthClient(this.config.baseUrl);
      const { error } = await call(formValues(event), client);
      if (error) {
        return false;
      }
      await fetchSession(this.config.baseUrl);
      bumpVersion(scope);
      if (options.redirect !== false) {
        navigate(this.redirects().afterSignIn);
      }
      return true;
    };
  }
}
