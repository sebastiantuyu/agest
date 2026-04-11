import path from "path";

export interface AgestConfig {
  parallelism?: number;
}

export function defineConfig(config: AgestConfig): AgestConfig {
  return config;
}

export async function loadConfig(): Promise<AgestConfig> {
  const candidates = [
    path.join(process.cwd(), "agest.config.ts"),
    path.join(process.cwd(), "agest.config.js"),
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      return (mod.default ?? mod) as AgestConfig;
    } catch {
      // file not found or failed to load — try next
    }
  }

  return {};
}
