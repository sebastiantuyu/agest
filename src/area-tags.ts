import type { AreaId } from "./areas.js";

/**
 * Marker interface for declaration merging — EMPTY by default.
 *
 * The auto-generated `agest-env.d.ts` (written by `agest typegen`, or by
 * `agest run` when it's missing) augments this with one `"<area-id>": true`
 * member per area opted into via `agest.config.ts`. Populating it flips
 * `AreaTag` from open (any string) to closed (exactly the configured set),
 * which is how `scene().tags(...)` becomes config-aware without the test file
 * ever importing the config. See src/typegen.ts.
 */
export interface AgestAreaRegistry {}

/**
 * The argument type accepted by `scene().tags(...)` and `SceneDefinition.tags`.
 *
 * - **No augmentation** (`AgestAreaRegistry` empty → `keyof` is `never`): the
 *   permissive branch `AreaId | (string & {})` — the catalog ids autocomplete,
 *   but any string is still allowed (back-compatible; preserves open domain
 *   tags).
 * - **Augmented** (the generated file is present): the closed branch — exactly
 *   the configured set, so typos and unconfigured/excluded areas are rejected.
 *
 * The `[T] extends [never]` tuple wrap is the canonical "is this `never`?"
 * guard; a bare `keyof … extends never` distributes and misbehaves on `never`.
 */
export type AreaTag = [keyof AgestAreaRegistry] extends [never]
  ? AreaId | (string & {})
  : keyof AgestAreaRegistry;
