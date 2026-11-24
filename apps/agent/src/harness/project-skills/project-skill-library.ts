import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { deepFreeze } from "../deep-freeze.js";
import { stringifyPromptJson } from "../prompt-json.js";

export const PROJECT_SKILL_LIMITS = Object.freeze({
  catalogBytes: 8 * 1024,
  bodyBytes: 16 * 1024,
  referenceBytes: 16 * 1024,
  loadResultBytes: 16 * 1024,
});

export const DEFAULT_PROJECT_SKILL_SOURCE_ROOT = fileURLToPath(
  new URL("../../../project-skills/", import.meta.url),
);

export interface ProjectSkillCatalogEntry {
  readonly name: string;
  readonly description: string;
}

export interface ProjectSkillReferenceDefinition {
  readonly file: string;
  readonly relativePath: string;
  readonly digest: string;
}

export interface ProjectSkillDefinition {
  readonly name: string;
  readonly origin: "project";
  readonly relativePath: string;
  readonly digest: string;
  readonly references: readonly ProjectSkillReferenceDefinition[];
}

export interface ProjectSkillLoadInput {
  readonly name: string;
  readonly file?: string;
}

export interface ProjectSkillLoadData {
  readonly name: string;
  readonly file: string;
  readonly digest: string;
  readonly content: string;
}

export type ProjectSkillLoadResult = Readonly<
  | { ok: true; message: string; data: ProjectSkillLoadData }
  | {
    ok: false;
    error: "SKILL_NOT_FOUND" | "REFERENCE_NOT_FOUND" | "CONTENT_TOO_LARGE";
    message: string;
    data: Readonly<{ available_names?: readonly string[] }>;
  }
>;

export interface ProjectSkillLoadExecution {
  readonly result: ProjectSkillLoadResult;
  readonly trace: Readonly<{
    project_skill: Readonly<Record<string, unknown>>;
  }>;
}

type SnapshotReference = Readonly<{
  file: string;
  relativePath: string;
  digest: string;
  content: string;
}>;

type SnapshotSkill = Readonly<{
  name: string;
  description: string;
  relativePath: string;
  digest: string;
  bodyDigest: string;
  body: string;
  references: readonly SnapshotReference[];
}>;

export class ProjectSkillBuildError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectSkillBuildError";
  }
}

export class ProjectSkillSnapshot {
  readonly #skillsByName: ReadonlyMap<string, SnapshotSkill>;

  public readonly identity: string;
  public readonly catalog: readonly ProjectSkillCatalogEntry[];
  public readonly definitions: readonly ProjectSkillDefinition[];
  public readonly catalogBytes: number;

  private constructor(skills: readonly SnapshotSkill[]) {
    const canonical = [...skills].sort((left, right) => compareText(left.name, right.name));
    this.#skillsByName = new Map(canonical.map((skill) => [skill.name, skill]));
    this.catalog = deepFreeze(canonical.map((skill) => ({
      name: skill.name,
      description: skill.description,
    })));
    this.catalogBytes = utf8Bytes(stringifyPromptJson(this.catalog));
    if (this.catalogBytes > PROJECT_SKILL_LIMITS.catalogBytes) {
      throw new ProjectSkillBuildError(
        `Project Skill catalog exceeds ${PROJECT_SKILL_LIMITS.catalogBytes} bytes`,
      );
    }
    this.definitions = deepFreeze(canonical.map((skill) => ({
      name: skill.name,
      origin: "project" as const,
      relativePath: skill.relativePath,
      digest: skill.digest,
      references: skill.references.map((reference) => ({
        file: reference.file,
        relativePath: reference.relativePath,
        digest: reference.digest,
      })),
    })));
    this.identity = sha256(JSON.stringify(canonical.map((skill) => [skill.name, skill.digest])));
    Object.freeze(this);
  }

  public static async buildFromTrustedRoot(sourceRoot: string): Promise<ProjectSkillSnapshot> {
    return new ProjectSkillSnapshot(await readProjectSkills(sourceRoot));
  }

  public load(input: ProjectSkillLoadInput): ProjectSkillLoadExecution {
    const skill = this.#skillsByName.get(input.name);
    if (skill === undefined) {
      return rejectedLoad(
        this.identity,
        input,
        "SKILL_NOT_FOUND",
        `Project Skill ${input.name} is not in the current Snapshot`,
        { availableNames: this.catalog.map((entry) => entry.name) },
      );
    }
    const selected = input.file === undefined
      ? {
          file: "SKILL.md",
          relativePath: skill.relativePath,
          digest: skill.bodyDigest,
          content: skill.body,
        }
      : skill.references.find((reference) => reference.file === input.file);
    if (selected === undefined) {
      return rejectedLoad(
        this.identity,
        input,
        "REFERENCE_NOT_FOUND",
        input.file === ""
          ? `Project Skill ${input.name}: omit file to load the main SKILL.md; an empty file is not a reference path`
          : `Project Skill ${input.name} does not declare ${input.file}`,
      );
    }
    const result = deepFreeze({
      ok: true as const,
      message: "loaded project Skill content",
      data: {
        name: skill.name,
        file: selected.file,
        digest: selected.digest,
        content: selected.content,
      },
    });
    const resultBytes = utf8Bytes(JSON.stringify(result));
    if (resultBytes > PROJECT_SKILL_LIMITS.loadResultBytes) {
      return rejectedLoad(
        this.identity,
        input,
        "CONTENT_TOO_LARGE",
        `Project Skill ${input.name} load result is ${resultBytes} bytes; limit is ${PROJECT_SKILL_LIMITS.loadResultBytes} bytes`,
        {
          bytes: resultBytes,
          selected: {
            file: selected.file,
            relativePath: selected.relativePath,
            digest: selected.digest,
            contentBytes: utf8Bytes(selected.content),
          },
        },
      );
    }
    return deepFreeze({
      result,
      trace: {
        project_skill: {
          snapshot_id: this.identity,
          origin: "project",
          name: skill.name,
          file: selected.file,
          relative_path: selected.relativePath,
          digest: selected.digest,
          bytes: utf8Bytes(selected.content),
          budget: { limit: PROJECT_SKILL_LIMITS.loadResultBytes, accepted: true },
        },
      },
    });
  }
}

export interface ProjectSkillSnapshotBuilder {
  build(): Promise<ProjectSkillSnapshot>;
}

export function createProjectSkillSnapshotBuilder(
  options: Readonly<{ sourceRoot?: string }> = {},
): ProjectSkillSnapshotBuilder {
  const sourceRoot = options.sourceRoot ?? DEFAULT_PROJECT_SKILL_SOURCE_ROOT;
  return Object.freeze({
    async build() {
      try {
        return await ProjectSkillSnapshot.buildFromTrustedRoot(sourceRoot);
      } catch (error) {
        if (error instanceof ProjectSkillBuildError) throw error;
        throw new ProjectSkillBuildError("Project Skill Snapshot build failed");
      }
    },
  });
}

async function readProjectSkills(sourceRoot: string): Promise<readonly SnapshotSkill[]> {
  try {
    const rootStatus = await lstat(sourceRoot);
    if (rootStatus.isSymbolicLink()) {
      throw new ProjectSkillBuildError("Project Skill source root may not be a symlink");
    }
    if (!rootStatus.isDirectory()) {
      throw new ProjectSkillBuildError("Project Skill source root must be a directory");
    }
  } catch (error) {
    if (isMissingFile(error)) return [];
    if (error instanceof ProjectSkillBuildError) throw error;
    throw new ProjectSkillBuildError("Project Skill source root could not be inspected");
  }
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch {
    throw new ProjectSkillBuildError("Project Skill source root could not be read");
  }
  const skills: SnapshotSkill[] = [];
  const names = new Set<string>();
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (entry.name === ".gitkeep") continue;
    const entryPath = join(sourceRoot, entry.name);
    const status = await lstat(entryPath);
    if (status.isSymbolicLink()) throw buildError(entry.name, "symlinks are not allowed");
    if (!status.isDirectory()) throw buildError(entry.name, "the trusted root may contain only Skill packages");
    const skill = await readSkillPackage(entryPath, entry.name);
    if (names.has(skill.name)) throw buildError(skill.name, "duplicate Project Skill name");
    if (skill.name !== entry.name) {
      throw buildError(entry.name, "frontmatter name must match the package directory");
    }
    names.add(skill.name);
    skills.push(skill);
  }
  return skills;
}

async function readSkillPackage(packagePath: string, directoryName: string): Promise<SnapshotSkill> {
  if (!isCanonicalProjectSkillName(directoryName)) {
    throw buildError(directoryName, "package directory must be lower_snake_case");
  }
  const entries = await readdir(packagePath, { withFileTypes: true });
  const allowed = new Set(["SKILL.md", "references"]);
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw buildError(directoryName, `unsupported package entry ${entry.name}`);
    }
    const status = await lstat(join(packagePath, entry.name));
    if (status.isSymbolicLink()) throw buildError(directoryName, `symlink ${entry.name} is not allowed`);
  }
  if (!entries.some((entry) => entry.name === "SKILL.md")) {
    throw buildError(directoryName, "SKILL.md is required");
  }

  const skillSource = await readMarkdown(
    join(packagePath, "SKILL.md"),
    PROJECT_SKILL_LIMITS.bodyBytes + PROJECT_SKILL_LIMITS.catalogBytes + 1024,
  );
  const parsed = parseSkillMarkdown(skillSource, directoryName);
  if (utf8Bytes(parsed.body) > PROJECT_SKILL_LIMITS.bodyBytes) {
    throw buildError(directoryName, `SKILL.md body exceeds ${PROJECT_SKILL_LIMITS.bodyBytes} bytes`);
  }
  const declaredReferences = declaredReferencePaths(parsed.body, directoryName);
  const references = await readReferences(packagePath, directoryName, declaredReferences);
  const bodyDigest = sha256(parsed.body);
  const relativePath = posix.join(directoryName, "SKILL.md");
  const digest = sha256(JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    name: parsed.name,
    description: parsed.description,
    bodyDigest,
    references: references.map((reference) => [reference.file, reference.digest]),
  }));
  return deepFreeze({
    name: parsed.name,
    description: parsed.description,
    relativePath,
    digest,
    bodyDigest,
    body: parsed.body,
    references,
  });
}

async function readReferences(
  packagePath: string,
  skillName: string,
  declared: ReadonlySet<string>,
): Promise<readonly SnapshotReference[]> {
  const referenceRoot = join(packagePath, "references");
  let entries;
  try {
    entries = await readdir(referenceRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error) && declared.size === 0) return [];
    if (isMissingFile(error)) throw buildError(skillName, "a declared reference is missing");
    throw error;
  }
  const references: SnapshotReference[] = [];
  const present = new Set<string>();
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = join(referenceRoot, entry.name);
    const status = await lstat(entryPath);
    if (status.isSymbolicLink()) throw buildError(skillName, `symlink references/${entry.name} is not allowed`);
    if (!status.isFile() || posix.extname(entry.name) !== ".md") {
      throw buildError(skillName, `only Markdown files are allowed under references/: ${entry.name}`);
    }
    const file = posix.join("references", entry.name);
    if (!declared.has(file)) throw buildError(skillName, `reference ${file} is not declared in SKILL.md`);
    const content = await readMarkdown(entryPath, PROJECT_SKILL_LIMITS.referenceBytes);
    present.add(file);
    references.push(deepFreeze({
      file,
      relativePath: posix.join(skillName, file),
      digest: sha256(content),
      content,
    }));
  }
  for (const file of declared) {
    if (!present.has(file)) throw buildError(skillName, `declared reference ${file} does not exist`);
  }
  return deepFreeze(references);
}

async function readMarkdown(path: string, byteLimit: number): Promise<string> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new ProjectSkillBuildError(`${basename(path)} may not be a symlink`);
  if (!status.isFile()) throw new ProjectSkillBuildError(`${basename(path)} must be a regular file`);
  const bytes = await readFile(path);
  if (bytes.byteLength > byteLimit) {
    throw new ProjectSkillBuildError(`${basename(path)} exceeds ${byteLimit} bytes`);
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectSkillBuildError(`${basename(path)} must be valid UTF-8`);
  }
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)) {
    throw new ProjectSkillBuildError(`${basename(path)} must be Markdown text, not binary content`);
  }
  return content;
}

function parseSkillMarkdown(source: string, directoryName: string): Readonly<{
  schemaVersion: 1;
  name: string;
  description: string;
  body: string;
}> {
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw buildError(directoryName, "SKILL.md must start with frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw buildError(directoryName, "SKILL.md frontmatter is not closed");
  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw buildError(directoryName, "frontmatter entries must use key: value");
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!new Set(["schema_version", "name", "description"]).has(key)) {
      throw buildError(directoryName, `unsupported frontmatter field ${key}`);
    }
    if (values.has(key)) throw buildError(directoryName, `duplicate frontmatter field ${key}`);
    if (rawValue === "") throw buildError(directoryName, `frontmatter field ${key} must not be empty`);
    values.set(key, parseFrontmatterScalar(rawValue, directoryName));
  }
  if (values.size !== 3) {
    throw buildError(directoryName, "frontmatter must contain only schema_version, name, and description");
  }
  if (values.get("schema_version") !== "1") throw buildError(directoryName, "unsupported schema_version");
  const name = values.get("name")!;
  if (!isCanonicalProjectSkillName(name)) throw buildError(directoryName, "name must be lower_snake_case");
  const description = values.get("description")!.trim();
  if (description === "") throw buildError(directoryName, "description must not be empty");
  const body = lines.slice(end + 1).join("\n").replace(/^\n/u, "");
  return deepFreeze({ schemaVersion: 1, name, description, body });
}

function parseFrontmatterScalar(value: string, skillName: string): string {
  if (value.startsWith("\"") || value.startsWith("'")) {
    if (value.startsWith("\"") && value.endsWith("\"")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "string") return parsed;
      } catch {
        // Report one stable frontmatter error below.
      }
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replaceAll("''", "'");
    }
    throw buildError(skillName, "frontmatter contains an invalid quoted scalar");
  }
  if (/\s+#/u.test(value) || /[\[\]{}]/u.test(value)) {
    throw buildError(skillName, "frontmatter supports only scalar values");
  }
  return value;
}

function declaredReferencePaths(body: string, skillName: string): ReadonlySet<string> {
  const declarations = new Set<string>();
  const pattern = /(?:^|[\s("'`])((?:\.\/)?references\/[^\s)"'`<>\]]+)/gmu;
  for (const match of body.matchAll(pattern)) {
    const candidate = (match[1] ?? "").replace(/[.,;:]+$/u, "").replace(/^\.\//u, "");
    if (!isCanonicalProjectSkillReferencePath(candidate)) {
      throw buildError(skillName, `invalid reference path ${candidate}`);
    }
    declarations.add(candidate);
  }
  return declarations;
}

export function isCanonicalProjectSkillReferencePath(value: string): boolean {
  return /^references\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u.test(value)
    && !posix.isAbsolute(value)
    && !value.split("/").includes("..");
}

export function isCanonicalProjectSkillName(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value);
}

function rejectedLoad(
  snapshotIdentity: string,
  input: ProjectSkillLoadInput,
  error: "SKILL_NOT_FOUND" | "REFERENCE_NOT_FOUND" | "CONTENT_TOO_LARGE",
  message: string,
  detail: Readonly<{
    bytes?: number;
    availableNames?: readonly string[];
    selected?: Readonly<{
      file: string;
      relativePath: string;
      digest: string;
      contentBytes: number;
    }>;
  }> | undefined = undefined,
): ProjectSkillLoadExecution {
  const result = deepFreeze({
    ok: false as const,
    error,
    message,
    data: detail?.availableNames === undefined
      ? {}
      : { available_names: [...detail.availableNames] },
  });
  return deepFreeze({
    result,
    trace: {
      project_skill: {
        snapshot_id: snapshotIdentity,
        origin: "project",
        name: input.name,
        ...(detail?.selected === undefined
          ? (input.file === undefined ? {} : { file: input.file })
          : {
              file: detail.selected.file,
              relative_path: detail.selected.relativePath,
              digest: detail.selected.digest,
              bytes: detail.selected.contentBytes,
              result_bytes: detail.bytes,
            }),
        error,
        budget: {
          limit: PROJECT_SKILL_LIMITS.loadResultBytes,
          accepted: false,
          ...(detail?.bytes === undefined ? {} : { bytes: detail.bytes }),
        },
      },
    },
  });
}

function buildError(skillName: string, message: string): ProjectSkillBuildError {
  return new ProjectSkillBuildError(`${skillName}: ${message}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
