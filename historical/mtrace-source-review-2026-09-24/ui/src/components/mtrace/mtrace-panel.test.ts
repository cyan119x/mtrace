/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawMtracePanel, type MtraceExportMode } from "./mtrace-panel.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_KEY = "agent:main:dashboard:current";

async function createPanel(overrides: Partial<OpenClawMtracePanel> = {}) {
  const panel = new OpenClawMtracePanel();
  panel.gatewayUrl = "ws://gateway.test:18789";
  panel.authToken = "device-credential";
  panel.connected = true;
  panel.agentId = "main";
  panel.sessionId = SESSION_ID;
  panel.sessionKey = SESSION_KEY;
  panel.sessionLabel = "System Operations";
  Object.assign(panel, overrides);
  document.body.appendChild(panel);
  await panel.updateComplete;
  return panel;
}

function artifactResponse(mode: MtraceExportMode) {
  return {
    artifactId: "11111111-1111-4111-8111-111111111111",
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    mode,
    filename: `mtrace-current-${mode}.md`,
    sizeBytes: 2048,
    eventCount: 12,
    runtimeEventCount: 5,
    transcriptEventCount: 7,
    expiresAt: "2026-09-19T09:00:00.000Z",
    includedFiles: ["manifest.json", "events.jsonl"],
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Mtrace session panel", () => {
  it("targets the current session automatically and enables all export actions", async () => {
    const panel = await createPanel();
    const text = panel.shadowRoot?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("System Operations");
    expect(text).toContain(SESSION_ID);
    expect(text).toContain(SESSION_KEY);
    expect(text).toContain("main");
    expect(panel.shadowRoot?.querySelector("input")).toBeNull();

    const buttons = [
      ...(panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-export-mode]") ?? []),
    ];
    expect(buttons.map((button) => button.dataset.exportMode)).toEqual([
      "full",
      "transcript",
      "prompt-tool-runtime",
    ]);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it.each<MtraceExportMode>(["full", "transcript", "prompt-tool-runtime"])(
    "sends exact current-session identity for the %s export",
    async (mode) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(artifactResponse(mode), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const panel = await createPanel();
      panel.shadowRoot?.querySelector<HTMLButtonElement>(`[data-export-mode="${mode}"]`)?.click();

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://gateway.test:18789/__openclaw__/mtrace/export");
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer device-credential",
        },
      });
      const requestBody = init?.body;
      expect(typeof requestBody).toBe("string");
      if (typeof requestBody !== "string") {
        throw new TypeError("expected a string request body");
      }
      expect(JSON.parse(requestBody)).toEqual({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        mode,
      });
      await vi.waitFor(() =>
        expect(panel.shadowRoot?.querySelector("[data-mtrace-artifact]")?.textContent).toContain(
          `mtrace-current-${mode}.md`,
        ),
      );
      expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain("Ready");
    },
  );

  it("keeps actions disabled until connection, identity, and an authenticated credential exist", async () => {
    const panel = await createPanel({ authToken: "" });
    const actions =
      panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-export-mode]") ?? [];
    expect([...actions].every((button) => button.disabled)).toBe(true);
    expect(panel.shadowRoot?.querySelector("[data-mtrace-not-ready]")).not.toBeNull();

    panel.authToken = "live-device-token";
    await panel.updateComplete;
    expect([...actions].every((button) => !button.disabled)).toBe(true);
  });

  it("shows a backend error and does not publish a download action", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "session identity mismatch" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const panel = await createPanel();
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[data-export-mode="full"]')?.click();

    await vi.waitFor(() =>
      expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
        "session identity mismatch",
      ),
    );
    expect(panel.shadowRoot?.querySelector("[data-mtrace-download]")).toBeNull();
    expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain("Failed");
  });

  it("downloads once with the authenticated request and clears the consumed artifact", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(artifactResponse("full"), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["mtrace"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:mtrace");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const panel = await createPanel();
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[data-export-mode="full"]')?.click();
    await vi.waitFor(() =>
      expect(panel.shadowRoot?.querySelector("[data-mtrace-download]")).not.toBeNull(),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-mtrace-download]")?.click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]).toEqual([
      "http://gateway.test:18789/__openclaw__/mtrace/download/11111111-1111-4111-8111-111111111111",
      { headers: { authorization: "Bearer device-credential" } },
    ]);
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(panel.shadowRoot?.querySelector("[data-mtrace-artifact]")).toBeNull();
    expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(
      "Download started",
    );
  });

  it("does not expose an artifact returned after the host switches sessions", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    const panel = await createPanel();
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[data-export-mode="full"]')?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    panel.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    panel.sessionKey = "agent:main:dashboard:replacement";
    await panel.updateComplete;
    resolveResponse?.(Response.json(artifactResponse("full"), { status: 200 }));

    await vi.waitFor(() =>
      expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
        "current session changed",
      ),
    );
    expect(panel.shadowRoot?.querySelector("[data-mtrace-artifact]")).toBeNull();
  });

  it("retires a ready artifact when the host switches sessions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(artifactResponse("full"), { status: 200 })),
    );
    const panel = await createPanel();
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[data-export-mode="full"]')?.click();
    await vi.waitFor(() =>
      expect(panel.shadowRoot?.querySelector("[data-mtrace-artifact]")).not.toBeNull(),
    );

    panel.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    panel.sessionKey = "agent:main:dashboard:replacement";
    await panel.updateComplete;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("[data-mtrace-artifact]")).toBeNull();
    expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(
      "Session changed",
    );
  });
});
