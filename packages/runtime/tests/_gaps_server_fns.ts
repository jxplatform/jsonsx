// Fixture server functions for runtime-gaps-resolve.test.ts (timing: "server")

export async function echoArgs(args: Record<string, unknown>) {
  return { got: args };
}

export async function double(args: Record<string, unknown>) {
  return ((args.n as number) ?? 0) * 2;
}

export async function failing(args: Record<string, unknown>) {
  if (args.boom) {
    throw new Error("boom");
  }
  return "ok";
}

export const notFn = 7;
