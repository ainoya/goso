import { loadConfig, type GosoConfig } from "./config.ts";
import { collectAntigravity } from "./providers/antigravity.ts";
import { collectClaude } from "./providers/claude.ts";
import { collectCodex } from "./providers/codex.ts";
import type { CollectOptions, ProviderId, ProviderSnapshot, Snapshot } from "./types.ts";

export * from "./types.ts";
export * from "./format.ts";
export * from "./summary.ts";
export { configPath, loadConfig } from "./config.ts";
export type { GosoConfig } from "./config.ts";

/** Display order: the agents with authoritative numbers come first. */
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "antigravity"];

type Collector = (now: number, config: GosoConfig, options: { offline?: boolean }) => Promise<ProviderSnapshot>;

const COLLECTORS: Record<ProviderId, Collector> = {
  claude: collectClaude,
  codex: (now) => collectCodex(now),
  antigravity: collectAntigravity,
};

/** Gather every provider's usage in parallel. A failing provider never fails the run. */
export async function collect(options: CollectOptions = {}): Promise<Snapshot> {
  const now = options.now ?? Date.now();
  const config = await loadConfig();
  const ids = options.only?.length ? PROVIDER_IDS.filter((id) => options.only!.includes(id)) : PROVIDER_IDS;

  const providers = await Promise.all(
    ids.map(async (id): Promise<ProviderSnapshot> => {
      try {
        return await COLLECTORS[id](now, config, { offline: options.offline });
      } catch (error) {
        return {
          id,
          label: id,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
          windows: [],
        };
      }
    }),
  );

  return { generatedAt: now, providers };
}
