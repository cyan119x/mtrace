import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

const mode = { type: "string", enum: ["full", "transcript", "prompt-tool-runtime", "history"] };
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

export const contract = defineFeatureContract({
  pluginId: "mtrace",
  operations: {
    status: {
      kind: "query",
      description: "Resolve the authoritative current MTrace session identity.",
      input: { type: "object", additionalProperties: false, properties: {} },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "sessionId", "sessionKey", "lifecycleRevision"],
        properties: {
          agentId: { type: "string" },
          sessionId: { type: "string" },
          sessionKey: { type: "string" },
          lifecycleRevision: nullableString
        }
      }
    },
    export: {
      kind: "action",
      description: "Create a one-time MTrace Markdown export for the current session.",
      input: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode }
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["artifactId", "mode", "filename", "sizeBytes", "downloadUrl", "expiresAt", "scope", "eventCount", "runtimeEventCount", "transcriptEventCount"],
        properties: {
          artifactId: { type: "string" }, mode, filename: { type: "string" }, sizeBytes: { type: "integer" },
          downloadUrl: { type: "string" }, expiresAt: { type: "string" },
          scope: { type: "string", enum: ["since-last-reset", "full-session"] },
          eventCount: { type: "integer" }, runtimeEventCount: { type: "integer" }, transcriptEventCount: { type: "integer" },
          resetBoundaryAt: nullableString, conversationStartedAt: nullableString
        }
      }
    }
  },
  events: {}
});
