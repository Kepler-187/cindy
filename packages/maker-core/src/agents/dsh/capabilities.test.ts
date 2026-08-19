import { describe, expect, it } from "vitest";

import type { AgentDeps } from "../base-agent.js";
import { DshAgent, textFromMessage } from "./index.js";

function createAgent(): DshAgent {
  return new DshAgent({
    binaryPath: "dsh-test",
    auth: {} as AgentDeps["auth"],
    runtimeConfig: {} as AgentDeps["runtimeConfig"],
    logger: {} as AgentDeps["logger"],
  });
}

describe("DshAgent capabilities", () => {
  it("starts with an empty model list until the host injects catalog-derived models", () => {
    expect(createAgent().capabilities.availableModels).toEqual([]);
  });

  it("exposes Cindy permission modes and DSH reasoning intensity levels", () => {
    const capabilities = createAgent().capabilities;
    expect(capabilities.permissionModes.map((mode) => mode.id)).toEqual([
      "ask",
      "auto",
      "bypassPermissions",
    ]);
    expect(capabilities.setPermissionModeMidSession?.supported).toBe(true);
    expect(capabilities.effortLevels.map((level) => level.id)).toEqual(["low", "high", "max"]);
    expect(capabilities.multimodal.image.supported).toBe(false);
    expect(capabilities.multimodal.file.supported).toBe(false);
  });

  it.each([
    { type: "image" as const, path: "/tmp/not-sent.png", mimeType: "image/png" },
    { type: "file" as const, path: "/tmp/not-sent.pdf", mimeType: "application/pdf" },
  ])("rejects $type blocks before they can reach DSH", (block) => {
    expect(() => textFromMessage({ type: "user", content: [block] })).toThrow(
      `dsh does not support ${block.type} attachments`,
    );
  });
});
