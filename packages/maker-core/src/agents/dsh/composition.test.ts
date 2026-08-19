import { describe, expect, it } from "vitest";

import { buildDshCordisConfig, renderDshCordisYaml } from "./composition.js";

describe("DSH Cordis composition", () => {
  it("overlays the official DSH base with Cindy's code runtime and dynamic preset service", () => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        bashLocal: false,
      }),
    );

    expect(yaml).toContain('id: "llm-deepseek"');
    expect(yaml).toContain('name: "@deepseek-ai/dsh-code-runtime-worker-thread"');
    expect(yaml).toContain('name: "@deepseek-ai/dsh-agent-presets"');
    expect(yaml).toContain('name: "./cindy-dsh-bridge.mjs"');
    expect(yaml).toContain('id: "tool-bash"\n  disabled: true');
  });

  it("carries the configured endpoint, context window, and reasoning default into the DeepSeek adapter", () => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "vendor-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        baseUrl: "https://gateway.example.test/deepseek",
        reasoningEffort: "low",
        models: [
          {
            id: "vendor-pro",
            name: "Vendor Pro",
            contextWindow: 640_000,
            maxTokens: 16_000,
          },
        ],
      }),
    );

    expect(yaml).toContain('baseURL: "https://gateway.example.test/deepseek"');
    expect(yaml).toContain('thinking: "enabled"');
    expect(yaml).toContain('reasoningEffort: "low"');
    expect(yaml).toContain('contextWindow: 640000');
    expect(yaml).toContain('maxTokens: 16000');
  });

  it("turns thinking off only when the configured DSH effort is off", () => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "vendor-flash",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        reasoningEffort: "off",
      }),
    );

    expect(yaml).toContain('thinking: "disabled"');
    expect(yaml).toContain('reasoningEffort: "off"');
  });

  it.each([
    ["always-on", "enabled"],
    ["always-off", "disabled"],
  ] as const)("renders fixed %s thinking without an unsupported effort field", (policy, thinking) => {
    const yaml = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "fixed-thinking-model",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        thinkingPolicy: policy,
        reasoningEffort: "high",
      }),
    );

    expect(yaml).toContain(`thinking: "${thinking}"`);
    expect(yaml).not.toContain("reasoningEffort:");
  });

  it("emits the mcp-cindy overlay row only for sessions with a plugin-channel endpoint", () => {
    const withMcp = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "vendor-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
        mcp: { url: "http://127.0.0.1:45678/mcp" },
      }),
    );
    expect(withMcp).toContain('id: "mcp-cindy"');
    expect(withMcp).toContain('name: "@deepseek-ai/dsh-mcp-client"');
    expect(withMcp).toContain('serverName: "cindy"');
    expect(withMcp).toContain('transport: "streamable-http"');
    expect(withMcp).toContain('url: "http://127.0.0.1:45678/mcp"');
    // Authorization 必须是 `!!js` env 引用——token 只经 CINDY_DSH_MCP_TOKEN env
    // 进子进程,明文不得出现在 YAML。
    expect(withMcp).toContain(
      'Authorization: !!js "\'Bearer \' + process.env.CINDY_DSH_MCP_TOKEN"',
    );
    expect(withMcp).not.toContain("Bearer 45678");
    expect(withMcp).not.toContain("Bearer 32");

    const withoutMcp = renderDshCordisYaml(
      buildDshCordisConfig({
        provider: "deepseek-official",
        model: "vendor-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        cwd: "C:/test-workdir",
        sessionRoot: "C:/test-sessions",
      }),
    );
    expect(withoutMcp).not.toContain("mcp-cindy");
    expect(withoutMcp).not.toContain("dsh-mcp-client");
    expect(withoutMcp).not.toContain("CINDY_DSH_MCP_TOKEN");
  });
});
