const input = JSON.parse(
  await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  }),
);

const cmd = input.tool_input?.command ?? "";

if (cmd.includes("git push")) {
  const { execSync } = await import("node:child_process");
  try {
    execSync("bun run all-the-things", { stdio: "inherit" });
  } catch {
    process.exit(1); // Block the push
  }
}
