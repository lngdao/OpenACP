import type { Config } from "./config.js";
import type { AgentDefinition } from "./types.js";
import { AgentInstance } from "./agent-instance.js";

export class AgentManager {
  constructor(private config: Config) {}

  getAvailableAgents(): AgentDefinition[] {
    return Object.entries(this.config.agents).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      workingDirectory: cfg.workingDirectory,
      env: cfg.env,
    }));
  }

  getAgent(name: string): AgentDefinition | undefined {
    const cfg = this.config.agents[name];
    if (!cfg) return undefined;
    return { name, ...cfg };
  }

  async spawn(
    agentName: string,
    workingDirectory: string,
  ): Promise<AgentInstance> {
    const agentDef = this.getAgent(agentName);
    if (!agentDef) throw new Error(`Agent "${agentName}" not found in config`);
    return AgentInstance.spawn(agentDef, workingDirectory);
  }

  async resume(
    agentName: string,
    workingDirectory: string,
    agentSessionId: string,
  ): Promise<AgentInstance> {
    const agentDef = this.getAgent(agentName);
    if (!agentDef) throw new Error(`Agent "${agentName}" not found in config`);
    return AgentInstance.resume(agentDef, workingDirectory, agentSessionId);
  }
}
