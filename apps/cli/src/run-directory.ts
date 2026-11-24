import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BatchPlan } from "@evicraft/benchmark/task-runner";

/** One `--set key.path=value` override; the value is parsed as JSON when it is valid JSON, else kept as text. */
export interface ConfigOverride {
  readonly path: readonly string[];
  readonly value: unknown;
}

export function parseOverride(text: string): ConfigOverride {
  const separator = text.indexOf("=");
  const key = separator < 0 ? "" : text.slice(0, separator).trim();
  if (!key || key.split(".").some(part => part === "")) throw new Error(`--set expects key.path=value, got ${JSON.stringify(text)}`);
  const raw = text.slice(separator + 1);
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* plain text */ }
  return { path: key.split("."), value };
}

function applyOverride(target: Record<string, unknown>, { path, value }: ConfigOverride): void {
  let node = target;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (next === undefined) node[part] = {};
    else if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error(`--set ${path.join(".")}: ${part} is not an object`);
    node = node[part] as Record<string, unknown>;
  }
  node[path.at(-1)!] = value;
}

/** Task-level paths that resolve against the config file's directory; the frozen copy lives elsewhere. */
const TASK_PATHS: readonly (readonly string[])[] = [["serverTemplatePath"], ["snapshotPath"], ["camera", "clientTemplatePath"]];

function absolutize(config: Record<string, unknown>, base: string): void {
  for (const path of TASK_PATHS) {
    let node: unknown = config;
    for (const part of path.slice(0, -1)) node = (node as Record<string, unknown> | undefined)?.[part];
    const holder = node as Record<string, unknown> | undefined;
    const key = path.at(-1)!;
    const value = holder?.[key];
    if (typeof value === "string" && !isAbsolute(value)) holder![key] = resolve(base, value);
  }
  // The Harness keeps running where the original config sits, so relative paths in `command` and `config`
  // resolve exactly as they did before the copy.
  const harness = (config.harness ??= {}) as Record<string, unknown>;
  const workingDirectory = typeof harness.workingDirectory === "string" ? harness.workingDirectory : ".";
  harness.workingDirectory = resolve(base, workingDirectory);
}

/** A Harness that replaces the one each config names: `run ... -- <command...>`. */
export interface HarnessReplacement {
  readonly command: readonly string[];
  /** Absolute; relative paths in `command` resolve against it. */
  readonly workingDirectory: string;
  /** Passed to the Harness as the task file's `config`; the config's own `harness.config` is dropped. */
  readonly config: unknown;
}

/** Narrow or resize a plan: `--instance`, `--repetitions`, `--concurrency`. */
export function reshapePlan(plan: BatchPlan, options: { readonly instances?: readonly string[]; readonly repetitions?: number; readonly concurrency?: number }): BatchPlan {
  let executions = plan.executions;
  if (options.instances?.length) {
    const known = [...new Set(executions.map(({ instance }) => instance.id))];
    const unknown = options.instances.filter(id => !known.includes(id));
    if (unknown.length) throw new Error(`Unknown instance ${unknown.map(id => JSON.stringify(id)).join(", ")}; the plan has ${known.join(", ")}`);
    executions = executions.filter(({ instance }) => options.instances!.includes(instance.id));
  }
  if (options.repetitions !== undefined) {
    const instances = [...new Map(executions.map(({ instance }) => [instance.id, instance])).values()];
    executions = instances.flatMap(instance => Array.from({ length: options.repetitions! }, (_, repetition) => ({ instance, repetition })));
  }
  return { concurrency: options.concurrency ?? plan.concurrency, executions };
}

/** One config as a run uses it: the replacement Harness and the overrides applied, and its paths made absolute. */
export async function freezeConfig(configPath: string, overrides: readonly ConfigOverride[], harness?: HarnessReplacement): Promise<Record<string, unknown>> {
  const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${configPath} must hold a JSON object`);
  const frozen = config as Record<string, unknown>;
  if (harness) frozen.harness = { command: [...harness.command], workingDirectory: harness.workingDirectory, config: harness.config };
  for (const override of overrides) applyOverride(frozen, override);
  absolutize(frozen, dirname(configPath));
  return frozen;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Fail before anything starts when a frozen config points at a template that `setup` has not built. */
export async function requireTemplates(config: Readonly<Record<string, unknown>>): Promise<void> {
  const camera = config.camera as { clientTemplatePath?: unknown } | null | undefined;
  for (const [name, path] of [["serverTemplatePath", config.serverTemplatePath], ["camera.clientTemplatePath", camera?.clientTemplatePath]] as const) {
    if (typeof path === "string" && !await exists(path)) throw new Error(`${name} ${path} does not exist; build the templates with \`npx evicraft setup --accept-eula\``);
  }
}

/**
 * Lay a new run directory out the way the scorers read it:
 *
 *   <run>/inputs/configs/<instance>.json   each config with overrides applied and task paths made absolute
 *   <run>/inputs/batch.yaml                the plan, pointing at those copies
 *   <run>/inputs/overrides.json            the --set overrides and the replacement Harness, as given
 *   <run>/dry-run.json                     the effective conditions of every instance
 *   <run>/raw/                             Runner output, written by the run itself
 */
export async function createRunDirectory(run: string, plan: BatchPlan, overrides: readonly ConfigOverride[],
  inspect: (plan: BatchPlan) => Promise<unknown>, harness?: HarnessReplacement): Promise<BatchPlan> {
  if (await exists(run)) throw new Error(`Run directory already exists: ${run}; choose a new --out`);
  const frozen = await freezePlan(join(run, "inputs"), plan, overrides, harness);
  await writeJson(join(run, "dry-run.json"), await inspect(frozen));
  await mkdir(join(run, "raw"), { recursive: true });
  return frozen;
}

export async function freezePlan(inputs: string, plan: BatchPlan, overrides: readonly ConfigOverride[], harness?: HarnessReplacement): Promise<BatchPlan> {
  if (!plan.executions.length) throw new Error("The plan has no executions");
  // Freeze and check every config before writing anything, so a bad plan leaves no half-made run directory.
  const configs = new Map<string, Record<string, unknown>>();
  for (const { instance } of plan.executions) {
    if (configs.has(instance.id)) continue;
    if (!/^[A-Za-z0-9._-]+$/u.test(instance.id)) throw new Error(`Instance id ${JSON.stringify(instance.id)} must use only letters, digits, '.', '_' and '-'`);
    const config = await freezeConfig(instance.configPath, overrides, harness);
    await requireTemplates(config);
    configs.set(instance.id, config);
  }
  const paths = new Map<string, string>();
  for (const [id, config] of configs) {
    const path = join(inputs, "configs", `${id}.json`);
    await writeJson(path, config);
    paths.set(id, path);
  }
  const frozen: BatchPlan = {
    concurrency: plan.concurrency,
    executions: plan.executions.map(({ instance, repetition }) => ({ instance: { ...instance, configPath: paths.get(instance.id)! }, repetition })),
  };
  const repetitions = new Map<string, number>();
  for (const { instance } of frozen.executions) repetitions.set(instance.id, (repetitions.get(instance.id) ?? 0) + 1);
  const instances = [...new Map(frozen.executions.map(({ instance }) => [instance.id, instance])).values()]
    .map(instance => ({ ...instance, repetitions: repetitions.get(instance.id)! }));
  // JSON is valid YAML, so loadBatch reads this file back unchanged.
  await writeJson(join(inputs, "batch.yaml"), { concurrency: frozen.concurrency, instances });
  await writeJson(join(inputs, "overrides.json"), {
    set: overrides.map(({ path, value }) => ({ key: path.join("."), value })),
    harness: harness ?? null,
  });
  return frozen;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
