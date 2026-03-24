import { createChildLogger } from "./log.js";
import type { Config } from "./config.js";

const log = createChildLogger({ module: "post-upgrade" });

/**
 * Post-upgrade dependency check — runs on every start.
 * Ensures dependencies are available for enabled features.
 * Silent if everything is OK.
 */
export async function runPostUpgradeChecks(config: Config): Promise<void> {
  const { commandExists } = await import("./agent-dependencies.js");

  // 1. Tunnel enabled → ensure provider binary
  if (config.tunnel.enabled) {
    if (config.tunnel.provider === "cloudflare") {
      try {
        const { ensureCloudflared } = await import(
          "../tunnel/providers/install-cloudflared.js"
        );
        await ensureCloudflared();
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          "Could not install cloudflared. Tunnel may not work.",
        );
      }
    } else {
      const providerCmd = config.tunnel.provider;
      if (!commandExists(providerCmd)) {
        log.warn(
          `Tunnel provider "${providerCmd}" is not installed. Install it or switch to cloudflare (free, auto-installed).`,
        );
      }
    }
  }

  // 3. Integration not installed → suggest
  try {
    const { getIntegration } = await import("../cli/integrate.js");
    const integration = getIntegration("claude");
    if (integration) {
      const allInstalled = integration.items.every((item) => item.isInstalled());
      if (!allInstalled) {
        log.info(
          'Claude CLI integration not installed. Run "openacp integrate claude" for session transfer + tunnel skill.',
        );
      }
    }
  } catch {
    // integrate module not available — skip
  }

  // 4. jq missing + handoff integration installed → auto-install
  try {
    const { getIntegration } = await import("../cli/integrate.js");
    const integration = getIntegration("claude");
    if (integration) {
      const handoff = integration.items.find((i) => i.id === "handoff");
      if (handoff?.isInstalled() && !commandExists("jq")) {
        try {
          const { ensureJq } = await import("./install-jq.js");
          await ensureJq();
        } catch (err) {
          log.warn(
            { err: (err as Error).message },
            "Could not install jq. Handoff hooks may not work.",
          );
        }
      }
    }
  } catch {
    // skip
  }

  // 5. unzip missing → warn (needed for binary agent installs)
  if (!commandExists("unzip")) {
    log.warn(
      "unzip is not installed. Some agent installations (binary distribution) may fail. Install: brew install unzip (macOS) or apt install unzip (Linux)",
    );
  }

  // 6. Check installed agents with uvx distribution → warn if uvx missing
  try {
    const { AgentStore } = await import("./agent-store.js");
    const store = new AgentStore();
    store.load();
    const entries = store.getInstalled();
    const hasUvxAgent = Object.values(entries).some(
      (a: { distribution?: string }) => a.distribution === "uvx",
    );
    if (hasUvxAgent && !commandExists("uvx")) {
      log.warn(
        "uvx is not installed but you have Python-based agents. Install: pip install uv",
      );
    }
  } catch {
    // skip
  }
}
