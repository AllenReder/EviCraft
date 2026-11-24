import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { abilities } from "../src/harness/abilities/index.js";
import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import { loadSkillControl } from "../src/harness/control-tools.js";
import { executeToolContract } from "../src/harness/tool-contract.js";

import {
  PROJECT_SKILL_LIMITS,
  ProjectSkillBuildError,
  createProjectSkillSnapshotBuilder,
} from "../src/harness/project-skills/project-skill-library.js";

describe("Project Skill Library", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("atomically snapshots a deterministic catalog, body, references, and loader provenance", async () => {
    const root = await createRoot();
    await writeSkill(root, "zeta_strategy", "Zeta strategy.", [
      "# Zeta strategy",
      "",
      "Load [the detailed workflow](references/workflow.md) when needed.",
    ].join("\n"), {
      "workflow.md": "# Workflow\n\nUse current evidence.",
    });
    await writeSkill(root, "alpha_strategy", "Alpha strategy.", "# Alpha strategy");

    const snapshot = await createProjectSkillSnapshotBuilder({ sourceRoot: root }).build();
    const originalIdentity = snapshot.identity;

    expect(snapshot.catalog).toEqual([
      { name: "alpha_strategy", description: "Alpha strategy." },
      { name: "zeta_strategy", description: "Zeta strategy." },
    ]);
    expect(snapshot.definitions).toEqual([
      expect.objectContaining({
        name: "alpha_strategy",
        origin: "project",
        relativePath: "alpha_strategy/SKILL.md",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        name: "zeta_strategy",
        origin: "project",
        relativePath: "zeta_strategy/SKILL.md",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        references: [{
          file: "references/workflow.md",
          relativePath: "zeta_strategy/references/workflow.md",
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }],
      }),
    ]);

    const body = snapshot.load({ name: "zeta_strategy" });
    expect(body).toMatchObject({
      result: {
        ok: true,
        message: "loaded project Skill content",
        data: {
          name: "zeta_strategy",
          file: "SKILL.md",
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          content: expect.stringContaining("# Zeta strategy"),
        },
      },
      trace: {
        project_skill: {
          snapshot_id: originalIdentity,
          origin: "project",
          name: "zeta_strategy",
          file: "SKILL.md",
          relative_path: "zeta_strategy/SKILL.md",
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          bytes: expect.any(Number),
          budget: { limit: 16 * 1024, accepted: true },
        },
      },
    });
    expect(snapshot.load({ name: "zeta_strategy", file: "references/workflow.md" })).toMatchObject({
      result: {
        ok: true,
        data: {
          file: "references/workflow.md",
          content: "# Workflow\n\nUse current evidence.",
        },
      },
      trace: {
        project_skill: {
          snapshot_id: originalIdentity,
          relative_path: "zeta_strategy/references/workflow.md",
        },
      },
    });
    expect(snapshot.load({ name: "missing_strategy" }).result).toEqual({
      ok: false,
      error: "SKILL_NOT_FOUND",
      message: "Project Skill missing_strategy is not in the current Snapshot",
      data: { available_names: ["alpha_strategy", "zeta_strategy"] },
    });
    expect(snapshot.load({ name: "zeta_strategy", file: "references/missing.md" }).result).toEqual({
      ok: false,
      error: "REFERENCE_NOT_FOUND",
      message: "Project Skill zeta_strategy does not declare references/missing.md",
      data: {},
    });

    await writeFile(join(root, "zeta_strategy", "SKILL.md"), skillMarkdown(
      "zeta_strategy",
      "Changed description.",
      "# Changed body\n\nLoad references/workflow.md when needed.",
    ));
    await writeFile(join(root, "zeta_strategy", "references", "workflow.md"), "# Changed workflow");

    expect(snapshot.identity).toBe(originalIdentity);
    expect(snapshot.catalog[1]).toEqual({ name: "zeta_strategy", description: "Zeta strategy." });
    expect(snapshot.load({ name: "zeta_strategy" }).result).toMatchObject({
      ok: true,
      data: { content: expect.stringContaining("# Zeta strategy") },
    });
    expect(snapshot.load({ name: "zeta_strategy", file: "references/workflow.md" }).result)
      .toMatchObject({ ok: true, data: { content: "# Workflow\n\nUse current evidence." } });

    const nextSnapshot = await createProjectSkillSnapshotBuilder({ sourceRoot: root }).build();
    expect(nextSnapshot.identity).not.toBe(originalIdentity);
    expect(nextSnapshot.catalog[1]).toEqual({ name: "zeta_strategy", description: "Changed description." });
    expect(nextSnapshot.load({ name: "zeta_strategy", file: "references/workflow.md" }).result)
      .toMatchObject({ ok: true, data: { content: "# Changed workflow" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.catalog)).toBe(true);
    expect(Object.isFrozen(snapshot.catalog[0])).toBe(true);
  });

  it("loads every production body and declared reference through the public control contract", async () => {
    const snapshot = await createProjectSkillSnapshotBuilder().build();
    expect(snapshot.catalog.length).toBeGreaterThan(0);
    for (const definition of snapshot.definitions) {
      for (const input of [
        { name: definition.name },
        ...definition.references.map(({ file }) => ({ name: definition.name, file })),
      ]) {
        const loaded = await executeToolContract(loadSkillControl, input,
          parsed => snapshot.load(parsed).result);
        expect(loaded.canonicalOutput.ok, JSON.stringify(input)).toBe(true);
        if (!loaded.canonicalOutput.ok) throw new Error(loaded.canonicalOutput.message);
        expect(loaded.canonicalOutput.data.content.length).toBeGreaterThan(0);
        expect(JSON.parse(loaded.modelContent)).toEqual(loaded.canonicalOutput);
      }
    }
  });

  it("type-checks every documented run_code snippet against the generated Code Mode SDK", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of abilities) await runtime.register(definition);
    const snapshot = await createProjectSkillSnapshotBuilder().build();
    const sources = new Map<string, string>([["/skills/sdk.d.ts", runtime.typescriptSdk()]]);
    for (const definition of snapshot.definitions) {
      const loaded = snapshot.load({ name: definition.name }).result;
      if (!loaded.ok) throw new Error(loaded.message);
      let index = 0;
      // A snippet is a run_code body: top-level await and return are legal inside the wrapper.
      for (const match of loaded.data.content.matchAll(/```ts\n([\s\S]*?)\n```/gu)) {
        sources.set(`/skills/${definition.name}-${index++}.ts`,
          `export async function program() {\n${match[1]!}\n}\n`);
      }
    }
    expect(sources.size).toBeGreaterThan(5);

    const options: ts.CompilerOptions = {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      lib: ["lib.es2023.d.ts"], types: ["node"], skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (fileName) => sources.has(fileName) || ts.sys.fileExists(fileName);
    host.readFile = (fileName) => sources.get(fileName) ?? readFile(fileName);
    host.getSourceFile = (fileName, language, onError) => {
      const source = sources.get(fileName);
      return source === undefined
        ? getSourceFile(fileName, language, onError)
        : ts.createSourceFile(fileName, source, language);
    };
    const program = ts.createProgram([...sources.keys()], options, host);
    const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      `${diagnostic.file?.fileName ?? "?"}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
    expect(errors).toEqual([]);
  });

  it("keeps body loading distinct from references and gives a usable empty-file recovery", async () => {
    const snapshot = await createProjectSkillSnapshotBuilder().build();
    const rejected = await executeToolContract(loadSkillControl,
      { name: "ore_mining", file: "" }, parsed => snapshot.load(parsed).result);
    expect(rejected.canonicalOutput).toMatchObject({ ok: false, error: "REFERENCE_NOT_FOUND" });
    expect(rejected.canonicalOutput.message).toContain("omit file");
    const recovered = await executeToolContract(loadSkillControl,
      { name: "ore_mining" }, parsed => snapshot.load(parsed).result);
    expect(recovered.canonicalOutput).toMatchObject({ ok: true, data: { file: "SKILL.md" } });
    expect(snapshot.load({ name: "ore_mining", file: "SKILL.md" }).result)
      .toMatchObject({ ok: false, error: "REFERENCE_NOT_FOUND" });
  });

  it("rejects an invalid package atomically without changing an existing Snapshot", async () => {
    const root = await createRoot();
    await writeSkill(root, "safe_strategy", "Safe strategy.", "# Safe strategy");
    const builder = createProjectSkillSnapshotBuilder({ sourceRoot: root });
    const snapshot = await builder.build();

    await writeFile(join(root, "safe_strategy", "run.js"), "spawn('unsafe')");

    await expect(builder.build()).rejects.toThrow("unsupported package entry run.js");
    expect(snapshot.catalog).toEqual([{ name: "safe_strategy", description: "Safe strategy." }]);
    expect(snapshot.load({ name: "safe_strategy" }).result).toMatchObject({
      ok: true,
      data: { content: expect.stringContaining("# Safe strategy") },
    });
  });

  it.each([
    ["unknown frontmatter", [
      "---",
      "schema_version: 1",
      "name: invalid_strategy",
      "description: Invalid.",
      "origin: project",
      "---",
      "# Invalid",
    ].join("\n"), "unsupported frontmatter field origin"],
    ["unsupported schema", [
      "---",
      "schema_version: 2",
      "name: invalid_strategy",
      "description: Invalid.",
      "---",
      "# Invalid",
    ].join("\n"), "unsupported schema_version"],
    ["non-canonical name", [
      "---",
      "schema_version: 1",
      "name: Invalid-Strategy",
      "description: Invalid.",
      "---",
      "# Invalid",
    ].join("\n"), "name must be lower_snake_case"],
  ])("rejects %s", async (_label, source, expected) => {
    const root = await createRoot();
    await mkdir(join(root, "invalid_strategy"));
    await writeFile(join(root, "invalid_strategy", "SKILL.md"), source);
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: root }).build())
      .rejects.toThrow(expected);
  });

  it("rejects invalid UTF-8 and binary Markdown", async () => {
    const invalidUtf8Root = await createRoot();
    await mkdir(join(invalidUtf8Root, "invalid_utf8"));
    await writeFile(join(invalidUtf8Root, "invalid_utf8", "SKILL.md"), Buffer.from([0xc3, 0x28]));
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: invalidUtf8Root }).build())
      .rejects.toThrow("valid UTF-8");

    const binaryRoot = await createRoot();
    await mkdir(join(binaryRoot, "binary_strategy"));
    await writeFile(join(binaryRoot, "binary_strategy", "SKILL.md"), Buffer.from([
      ...Buffer.from(skillMarkdown("binary_strategy", "Binary.", "# Binary")),
      0,
    ]));
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: binaryRoot }).build())
      .rejects.toThrow("not binary content");
  });

  it("rejects symlinks, undeclared references, missing declarations, scripts, and binaries", async () => {
    const realRoot = await createRoot();
    await writeSkill(realRoot, "real_strategy", "Real.", "# Real");
    const linkContainer = await createRoot();
    const linkedRoot = join(linkContainer, "linked-root");
    await symlink(realRoot, linkedRoot, "dir");
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: linkedRoot }).build())
      .rejects.toThrow("Project Skill source root may not be a symlink");

    const symlinkRoot = await createRoot();
    await writeSkill(symlinkRoot, "linked_strategy", "Linked.",
      "# Linked\n\nLoad references/linked.md.");
    await writeFile(join(symlinkRoot, "outside.md"), "outside");
    await mkdir(join(symlinkRoot, "linked_strategy", "references"));
    await symlink(join(symlinkRoot, "outside.md"),
      join(symlinkRoot, "linked_strategy", "references", "linked.md"));
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: symlinkRoot }).build())
      .rejects.toThrow("symlink references/linked.md is not allowed");

    const undeclaredRoot = await createRoot();
    await writeSkill(undeclaredRoot, "undeclared_strategy", "Undeclared.", "# Undeclared", {
      "extra.md": "# Extra",
    });
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: undeclaredRoot }).build())
      .rejects.toThrow("reference references/extra.md is not declared");

    const missingRoot = await createRoot();
    await writeSkill(missingRoot, "missing_strategy", "Missing.",
      "# Missing\n\nLoad references/missing.md.");
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: missingRoot }).build())
      .rejects.toThrow("a declared reference is missing");

    const scriptRoot = await createRoot();
    await writeSkill(scriptRoot, "script_strategy", "Script.", "# Script");
    await mkdir(join(scriptRoot, "script_strategy", "references"));
    await writeFile(join(scriptRoot, "script_strategy", "references", "run.js"), "eval('unsafe')");
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: scriptRoot }).build())
      .rejects.toThrow("only Markdown files are allowed");

    const binaryFileRoot = await createRoot();
    await writeSkill(binaryFileRoot, "binary_file_strategy", "Binary file.", "# Binary file");
    await writeFile(join(binaryFileRoot, "binary_file_strategy", "payload.bin"), Buffer.from([0, 1, 2]));
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: binaryFileRoot }).build())
      .rejects.toThrow("unsupported package entry payload.bin");
  });

  it("rejects duplicate names and unsafe declared paths", async () => {
    const duplicateRoot = await createRoot();
    await writeSkill(duplicateRoot, "original_strategy", "Original.", "# Original");
    await mkdir(join(duplicateRoot, "z_copy_strategy"));
    await writeFile(join(duplicateRoot, "z_copy_strategy", "SKILL.md"),
      skillMarkdown("original_strategy", "Duplicate.", "# Duplicate"));
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: duplicateRoot }).build())
      .rejects.toThrow("duplicate Project Skill name");

    const traversalRoot = await createRoot();
    await writeSkill(traversalRoot, "traversal_strategy", "Traversal.",
      "# Traversal\n\nLoad references/../secret.md.");
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: traversalRoot }).build())
      .rejects.toThrow("invalid reference path references/../secret.md");
  });

  it("enforces catalog, body, reference, and serialized load-result budgets without truncation", async () => {
    const bodyRoot = await createRoot();
    await writeSkill(bodyRoot, "large_body", "Large body.", "x".repeat(PROJECT_SKILL_LIMITS.bodyBytes + 1));
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: bodyRoot }).build())
      .rejects.toThrow(`SKILL.md body exceeds ${PROJECT_SKILL_LIMITS.bodyBytes} bytes`);

    const referenceRoot = await createRoot();
    await writeSkill(referenceRoot, "large_reference", "Large reference.",
      "# Large reference\n\nLoad references/large.md.", {
        "large.md": "x".repeat(PROJECT_SKILL_LIMITS.referenceBytes + 1),
      });
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: referenceRoot }).build())
      .rejects.toThrow(`large.md exceeds ${PROJECT_SKILL_LIMITS.referenceBytes} bytes`);

    const catalogRoot = await createRoot();
    await writeSkill(catalogRoot, "large_catalog", "x".repeat(PROJECT_SKILL_LIMITS.catalogBytes), "# Catalog");
    await expect(createProjectSkillSnapshotBuilder({ sourceRoot: catalogRoot }).build())
      .rejects.toThrow(`catalog exceeds ${PROJECT_SKILL_LIMITS.catalogBytes} bytes`);

    const loadRoot = await createRoot();
    await writeSkill(loadRoot, "large_load", "Large load.", "x".repeat(PROJECT_SKILL_LIMITS.bodyBytes - 1));
    const loadSnapshot = await createProjectSkillSnapshotBuilder({ sourceRoot: loadRoot }).build();
    const execution = loadSnapshot.load({ name: "large_load" });
    expect(execution.result).toEqual({
      ok: false,
      error: "CONTENT_TOO_LARGE",
      message: expect.stringMatching(/^Project Skill large_load load result is \d+ bytes; limit is 16384 bytes$/),
      data: {},
    });
    expect(execution.trace).toMatchObject({
      project_skill: {
        snapshot_id: loadSnapshot.identity,
        origin: "project",
        name: "large_load",
        file: "SKILL.md",
        relative_path: "large_load/SKILL.md",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        bytes: PROJECT_SKILL_LIMITS.bodyBytes,
        result_bytes: expect.any(Number),
        error: "CONTENT_TOO_LARGE",
        budget: { limit: PROJECT_SKILL_LIMITS.loadResultBytes, accepted: false },
      },
    });
    expect(JSON.stringify(execution.result)).not.toContain("x".repeat(100));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mc-agent-project-skills-"));
    directories.push(root);
    return root;
  }
});

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body: string,
  references: Readonly<Record<string, string>> = {},
): Promise<void> {
  const packageDirectory = join(root, name);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "SKILL.md"), skillMarkdown(name, description, body));
  if (Object.keys(references).length === 0) return;
  const referenceDirectory = join(packageDirectory, "references");
  await mkdir(referenceDirectory);
  await Promise.all(Object.entries(references).map(async ([file, content]) => {
    await writeFile(join(referenceDirectory, file), content);
  }));
}

function skillMarkdown(name: string, description: string, body: string): string {
  return [
    "---",
    "schema_version: 1",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
    "",
  ].join("\n");
}
