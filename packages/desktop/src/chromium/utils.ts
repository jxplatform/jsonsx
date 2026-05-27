import { sessionBus } from "dbus-ts";

// Minimal D-Bus portal interface types (external/opaque)
interface DbusFileChooserPortal {
  OpenFile(
    parent: string,
    title: string,
    options: Array<[string, [string, unknown]]>,
  ): Promise<[string, ...unknown[]]>;
}

interface DbusRequest {
  on(event: "Response", handler: (response: number, results: unknown) => void): void;
}

export async function openFileDialog(): Promise<string | null> {
  const bus = await sessionBus();

  try {
    const portal = (await bus.getInterface(
      "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop",
      "org.freedesktop.portal.FileChooser",
    )) as unknown as DbusFileChooserPortal;

    const handleToken = `bun_${Math.random().toString(36).substring(2, 11)}`;

    const options = [
      ["directory", ["b", false]],
      ["modal", ["b", true]],
      ["handle_token", ["s", handleToken]],
      ["filters", ["a(sa(us))", [["Project files", [[0, "*.json"]]]]]],
    ];

    const [handle] = await portal.OpenFile(
      "",
      "Open project.json",
      options as Array<[string, [string, unknown]]>,
    );

    const result = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 60_000);

      bus
        .getInterface("org.freedesktop.portal.Desktop", handle, "org.freedesktop.portal.Request")
        .then((request: unknown) => {
          (request as DbusRequest).on("Response", (response: number, results: unknown) => {
            clearTimeout(timeout);
            if (response !== 0) {
              resolve(null);
              return;
            }
            // D-Bus portal response: nested array format [key, [type, value[]]] or {uris: string[]}
            const r = results as Record<string, unknown> & Array<[string, [string, string[]]]>;
            const uris: string[] = r[0]?.[1]?.[1] ?? (r.uris as string[] | undefined) ?? [];
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
