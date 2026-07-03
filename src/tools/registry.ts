/**
 * registry.ts — a Map-backed tool registry. Advertises enabled tools to the
 * model as `ToolSpec[]`, resolves tools by name for the loop, and produces a
 * restricted `subset` view for subagents.
 *
 * (Brought forward from build-order slice 2: the slice-1 loop needs a registry
 * to advertise and dispatch the bash/read tools.)
 */

import type { Tool, ToolRegistry, ToolSpec } from '../contracts.ts';

/** Build a registry from a list of tools (later duplicates win by name). */
export function createRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();
  for (const tool of tools) byName.set(tool.name, tool);

  const registry: ToolRegistry = {
    get(name: string): Tool | undefined {
      return byName.get(name);
    },
    list(): Tool[] {
      return [...byName.values()];
    },
    specs(): ToolSpec[] {
      return [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    subset(names: string[]): ToolRegistry {
      const allowed = names
        .map((name) => byName.get(name))
        .filter((tool): tool is Tool => tool !== undefined);
      return createRegistry(allowed);
    },
  };

  return registry;
}
