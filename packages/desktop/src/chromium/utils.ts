import { sessionBus } from "dbus-ts";

export async function openFileDialog(): Promise<string | null> {
  const bus = await sessionBus();

  try {
    const portal = (await bus.getInterface(
      "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop",
      "org.freedesktop.portal.FileChooser",
    )) as any;

    const handleToken = `bun_${Math.random().toString(36).substring(2, 11)}`;

    const options = [
      ["directory", ["b", false]],
      ["modal", ["b", true]],
      ["handle_token", ["s", handleToken]],
      ["filters", ["a(sa(us))", [["Project files", [[0, "*.json"]]]]]],
    ];

    const [handle] = await portal.OpenFile("", "Open project.json", options);

    const result = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 60_000);

      bus
        .getInterface("org.freedesktop.portal.Desktop", handle, "org.freedesktop.portal.Request")
        .then((request: any) => {
          request.on("Response", (response: number, results: any) => {
            clearTimeout(timeout);
            if (response !== 0) {
              resolve(null);
              return;
            }
            const uris: string[] = results[0]?.[1]?.[1] || results.uris || [];
            if (uris.length === 0) {
              resolve(null);
              return;
            }
            try {
              const filePath = new URL(uris[0]).pathname;
              resolve(filePath);
            } catch {
              resolve(null);
            }
          });
        });
    });

    return result;
  } finally {
    bus.connection.end();
  }
}
