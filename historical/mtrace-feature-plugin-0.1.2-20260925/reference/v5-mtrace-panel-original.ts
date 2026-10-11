import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

export type MtraceExportMode = "full" | "transcript" | "prompt-tool-runtime" | "history";

type MtraceArtifact = {
  id: string;
  mode: MtraceExportMode;
  filename: string;
  sizeBytes: number;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  expiresAt: string;
  includedFiles: string[];
  scope?: "since-last-reset" | "full-session";
  resetBoundaryAt?: string;
  conversationStartedAt?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXPORT_ACTIONS: ReadonlyArray<{
  mode: MtraceExportMode;
  label: string;
  description: string;
  primary?: boolean;
}> = [
  {
    mode: "full",
    label: "Export current conversation — full evidence",
    description:
      "All available transcript, prompt, tool, and runtime evidence since the most recent session reset.",
    primary: true,
  },
  {
    mode: "transcript",
    label: "Export current conversation — transcript",
    description:
      "Complete transcript event stream since the most recent reset, without the bounded branch projection.",
  },
  {
    mode: "prompt-tool-runtime",
    label: "Export current conversation — prompt + tool/runtime",
    description:
      "Current prompt, tool, runtime, metadata, and raw mixed event evidence for debugging.",
  },
  {
    mode: "history",
    label: "Export full sidebar-session history",
    description:
      "Forensic mode: includes every retained conversation epoch under this persistent sidebar session.",
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export class OpenClawMtracePanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      height: 100%;
      color: var(--text);
      background: var(--panel);
    }
    * {
      box-sizing: border-box;
    }
    h2,
    h3,
    p {
      margin: 0;
    }
    .mtrace {
      display: grid;
      align-content: start;
      gap: var(--space-4);
      height: 100%;
      padding: var(--space-5);
      overflow: auto;
    }
    .masthead {
      display: grid;
      gap: 7px;
      padding: 4px 2px 2px;
    }
    .eyebrow {
      color: var(--primary);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    h2 {
      font-size: clamp(20px, 2.2vw, 27px);
      line-height: 1.12;
      letter-spacing: -0.025em;
    }
    h3 {
      font-size: 14px;
      line-height: 1.25;
    }
    .lede,
    .meta,
    .status,
    .action p,
    .identity-label {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .card {
      display: grid;
      gap: 14px;
      min-width: 0;
      padding: 17px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--card);
      box-shadow: var(--shadow-sm);
    }
    .identity {
      gap: 14px;
    }
    .session-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: none;
      padding: 4px 8px;
      border: 1px solid color-mix(in srgb, var(--primary) 45%, transparent);
      border-radius: 999px;
      color: var(--primary);
      font-size: 11px;
      font-weight: 650;
    }
    .live-badge::before {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      content: "";
    }
    .identity-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .identity-row {
      display: grid;
      gap: 4px;
      min-width: 0;
      padding: 10px;
      border-radius: 9px;
      background: color-mix(in srgb, var(--card) 94%, var(--text) 6%);
    }
    .identity-row--wide {
      grid-column: 1 / -1;
    }
    .identity-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    code,
    .filename {
      overflow-wrap: anywhere;
    }
    code {
      font-size: 11px;
      line-height: 1.45;
    }
    .actions {
      gap: 12px;
    }
    .action {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "copy button" "description button";
      column-gap: 16px;
      row-gap: 4px;
      align-items: center;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 11px;
      background: color-mix(in srgb, var(--card) 96%, var(--text) 4%);
    }
    .action-title {
      grid-area: copy;
      font-size: 13px;
      font-weight: 700;
    }
    .action p {
      grid-area: description;
    }
    button {
      grid-area: button;
      appearance: none;
      min-height: 36px;
      padding: 8px 12px;
      border: 1px solid var(--border-strong, var(--border));
      border-radius: 8px;
      color: var(--text);
      background: transparent;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition:
        background 140ms ease,
        border-color 140ms ease,
        transform 140ms ease;
    }
    button:hover:not(:disabled) {
      border-color: var(--primary);
      background: color-mix(in srgb, var(--primary) 13%, transparent);
    }
    button:active:not(:disabled) {
      transform: translateY(1px);
    }
    button:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--primary) 60%, transparent);
      outline-offset: 2px;
    }
    button:disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }
    .action--primary {
      border-color: color-mix(in srgb, var(--primary) 35%, var(--border));
    }
    .action--primary button,
    .download {
      border-color: var(--primary);
      color: var(--primary-foreground);
      background: var(--primary);
    }
    .action--primary button:hover:not(:disabled),
    .download:hover:not(:disabled) {
      background: var(--primary-hover);
    }
    .helper {
      padding: 11px 12px;
      border-left: 3px solid var(--primary);
      border-radius: 0 8px 8px 0;
      background: color-mix(in srgb, var(--primary) 9%, transparent);
    }
    .status-card {
      gap: 10px;
    }
    .status {
      min-height: 20px;
    }
    .artifact {
      display: grid;
      gap: 8px;
      min-width: 0;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .filename {
      font-size: 13px;
      line-height: 1.4;
    }
    .inventory {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .inventory span {
      padding: 3px 6px;
      border-radius: 5px;
      color: var(--muted);
      background: color-mix(in srgb, var(--card) 90%, var(--text) 10%);
      font:
        10px/1.3 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }
    .error {
      color: var(--danger);
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 560px) {
      .identity-grid {
        grid-template-columns: 1fr;
      }
      .identity-row--wide {
        grid-column: auto;
      }
      .action {
        grid-template-columns: 1fr;
        grid-template-areas: "copy" "description" "button";
      }
      .action button {
        width: 100%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      button {
        transition: none;
      }
    }
  `;

  @property({ type: String }) gatewayUrl = "";
  @property({ type: String }) authToken = "";
  @property({ type: Boolean }) connected = false;
  @property({ type: String }) agentId = "";
  @property({ type: String }) sessionId = "";
  @property({ type: String }) sessionKey = "";
  @property({ type: String }) lifecycleRevision = "";
  @property({ type: String }) sessionLabel = "";

  @state() private status = "Idle · Ready to export the current conversation.";
  @state() private busyMode: MtraceExportMode | "download" | null = null;
  @state() private error = "";
  @state() private artifact: MtraceArtifact | null = null;

  private endpoint(path: string): string {
    const source = this.gatewayUrl.trim().replace(/^ws/i, "http");
    return new URL(path, source || window.location.href).toString();
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.authToken}`,
    };
  }

  private get identityReady(): boolean {
    return Boolean(
      this.connected &&
      this.agentId.trim() &&
      UUID_PATTERN.test(this.sessionId.trim()) &&
      this.sessionKey.trim() &&
      this.authToken.trim(),
    );
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (
      this.artifact &&
      (["agentId", "sessionId", "sessionKey", "lifecycleRevision"] as const).some(
        (key) => changed.has(key) && changed.get(key) !== undefined,
      )
    ) {
      this.artifact = null;
      this.error = "";
      this.status = "Idle · Session changed; ready to create a new current-conversation export.";
    }
  }

  private async exportSession(mode: MtraceExportMode): Promise<void> {
    if (!this.identityReady || this.busyMode) {
      return;
    }
    const identity = `${this.agentId.trim()}\n${this.sessionId.trim()}\n${this.sessionKey.trim()}\n${this.lifecycleRevision.trim()}`;
    this.busyMode = mode;
    this.error = "";
    this.artifact = null;
    this.status = "Validating the current session…";
    await this.updateComplete;
    this.status = "Exporting raw evidence and building the Markdown artifact…";
    const slowNotice = window.setTimeout(() => {
      if (this.busyMode === mode) {
        this.status = "Still creating the export. Large trajectories can take a minute or more…";
      }
    }, 15_000);
    try {
      const response = await fetch(this.endpoint("/__openclaw__/mtrace/export"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          agentId: this.agentId.trim(),
          sessionId: this.sessionId.trim(),
          sessionKey: this.sessionKey.trim(),
          lifecycleRevision: this.lifecycleRevision.trim() || undefined,
          mode,
        }),
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (
        `${this.agentId.trim()}\n${this.sessionId.trim()}\n${this.sessionKey.trim()}\n${this.lifecycleRevision.trim()}` !==
        identity
      ) {
        throw new Error(
          "The current session changed while Mtrace was exporting; the stale artifact was not offered.",
        );
      }
      if (
        !response.ok ||
        typeof result.artifactId !== "string" ||
        typeof result.filename !== "string" ||
        result.mode !== mode ||
        result.agentId !== this.agentId.trim() ||
        result.sessionId !== this.sessionId.trim() ||
        result.sessionKey !== this.sessionKey.trim()
      ) {
        throw new Error(
          typeof result.error === "string" ? result.error : `Export failed (${response.status})`,
        );
      }
      this.artifact = {
        id: result.artifactId,
        mode,
        filename: result.filename,
        sizeBytes: typeof result.sizeBytes === "number" ? result.sizeBytes : 0,
        eventCount: typeof result.eventCount === "number" ? result.eventCount : 0,
        runtimeEventCount:
          typeof result.runtimeEventCount === "number" ? result.runtimeEventCount : 0,
        transcriptEventCount:
          typeof result.transcriptEventCount === "number" ? result.transcriptEventCount : 0,
        expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : "",
        includedFiles: Array.isArray(result.includedFiles)
          ? result.includedFiles.filter((value): value is string => typeof value === "string")
          : [],
        scope:
          result.scope === "since-last-reset" || result.scope === "full-session"
            ? result.scope
            : undefined,
        resetBoundaryAt:
          typeof result.resetBoundaryAt === "string" ? result.resetBoundaryAt : undefined,
        conversationStartedAt:
          typeof result.conversationStartedAt === "string"
            ? result.conversationStartedAt
            : undefined,
      };
      this.status = "Ready · Download is available for 30 minutes.";
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Mtrace export failed";
      this.status = "Failed · No artifact was created.";
    } finally {
      window.clearTimeout(slowNotice);
      this.busyMode = null;
    }
  }

  private async download(): Promise<void> {
    if (!this.artifact || !this.authToken.trim() || this.busyMode) {
      return;
    }
    const artifact = this.artifact;
    this.busyMode = "download";
    this.error = "";
    this.status = "Downloading to this computer…";
    try {
      const response = await fetch(this.endpoint(`/__openclaw__/mtrace/download/${artifact.id}`), {
        headers: { authorization: `Bearer ${this.authToken}` },
      });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      this.status = "Download started in this browser.";
      this.artifact = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Mtrace download failed";
      this.status = "Download failed · The artifact may have expired or already been used.";
    } finally {
      this.busyMode = null;
    }
  }

  override render() {
    const identityReady = this.identityReady;
    return html`
      <section class="mtrace">
        <header class="masthead">
          <span class="eyebrow">Evidence bundle</span>
          <h2>Mtrace — Current conversation</h2>
          <p class="lede">
            Create a verified Markdown evidence export from the conversation open in this chat.
          </p>
        </header>

        <div class="card identity" data-mtrace-target>
          <div class="session-heading">
            <h3>Export target</h3>
            <span class="live-badge">Current conversation</span>
          </div>
          <div class="identity-grid">
            <div class="identity-row">
              <span class="identity-label">Session</span
              ><strong>${this.sessionLabel || "Current session"}</strong>
            </div>
            <div class="identity-row">
              <span class="identity-label">Agent</span><code>${this.agentId || "Unavailable"}</code>
            </div>
            <div class="identity-row identity-row--wide">
              <span class="identity-label">Session ID</span
              ><code>${this.sessionId || "Waiting for session identity…"}</code>
            </div>
            <div class="identity-row identity-row--wide">
              <span class="identity-label">Canonical key</span
              ><code>${this.sessionKey || "Unavailable"}</code>
            </div>
          </div>
          <p class="helper">
            Current-conversation exports begin after the most recent session reset. Use full
            sidebar-session history only when you intentionally need older epochs.
          </p>
        </div>

        <div class="card actions">
          <h3>Choose evidence to include</h3>
          ${EXPORT_ACTIONS.map(
            (action) => html`
              <div class="action ${action.primary ? "action--primary" : ""}">
                <strong class="action-title">${action.label}</strong>
                <p>${action.description}</p>
                <button
                  data-export-mode=${action.mode}
                  ?disabled=${!identityReady || this.busyMode !== null}
                  @click=${() => void this.exportSession(action.mode)}
                >
                  ${this.busyMode === action.mode ? "Creating export…" : "Create export"}
                </button>
              </div>
            `,
          )}
          ${
            !identityReady
              ? html`<p class="error" data-mtrace-not-ready>
                  Waiting for a connected session identity and authenticated Control UI credential.
                </p>`
              : nothing
          }
        </div>

        <div class="card status-card">
          <h3>Export status</h3>
          <p class="status" role="status">${this.status}</p>
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
          ${
            this.artifact
              ? html`<div class="artifact" data-mtrace-artifact>
                  <strong class="filename">${this.artifact.filename}</strong>
                  <span class="meta">
                    ${formatBytes(this.artifact.sizeBytes)} · ${this.artifact.eventCount} events ·
                    ${this.artifact.runtimeEventCount} runtime ·
                    ${this.artifact.transcriptEventCount} transcript
                  </span>
                  ${
                    this.artifact.scope
                      ? html`<span class="meta">
                          Scope:
                          ${
                            this.artifact.scope === "since-last-reset"
                              ? "current conversation since latest reset"
                              : "full sidebar-session history"
                          }
                        </span>`
                      : nothing
                  }
                  ${
                    this.artifact.resetBoundaryAt
                      ? html`<span class="meta"
                          >Reset boundary: ${this.artifact.resetBoundaryAt}</span
                        >`
                      : nothing
                  }
                  ${
                    this.artifact.conversationStartedAt
                      ? html`<span class="meta"
                          >Conversation start: ${this.artifact.conversationStartedAt}</span
                        >`
                      : nothing
                  }
                  <div class="inventory" aria-label="Included files">
                    ${this.artifact.includedFiles.map((file) => html`<span>${file}</span>`)}
                  </div>
                  ${this.artifact.expiresAt ? html`<span class="meta">Available until ${this.artifact.expiresAt}</span>` : nothing}
                  <button
                    class="download"
                    data-mtrace-download
                    ?disabled=${this.busyMode !== null || !this.authToken.trim()}
                    @click=${() => void this.download()}
                  >
                    ${this.busyMode === "download" ? "Downloading…" : "Download Markdown once"}
                  </button>
                </div>`
              : nothing
          }
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-mtrace-panel")) {
  customElements.define("openclaw-mtrace-panel", OpenClawMtracePanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mtrace-panel": OpenClawMtracePanel;
  }
}
