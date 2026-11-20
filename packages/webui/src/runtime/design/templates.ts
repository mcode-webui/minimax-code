import { mkdir, readFile, readdir, lstat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesignTemplate } from "../../shared/contracts/design.js";
import { BUILTIN_TEMPLATES } from "../../shared/design/builtin-templates.mjs";
import { templateStepsError } from "../../shared/design/actions.mjs";

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error("Invalid Design template identifier");
  return value;
}
export async function readDesignTemplates(dataDir: string): Promise<DesignTemplate[]> {
  const directory = path.join(dataDir, "templates");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const own: DesignTemplate[] = [];
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    identifier(entry.slice(0, -5));
    const file = path.join(directory, entry);
    let contents: string;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Design template must be a regular file");
      contents = await readFile(file, "utf8");
    } catch (error) {
      // Another request can remove a template after readdir listed it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const template = JSON.parse(contents) as DesignTemplate;
    const error = templateStepsError(template.actions);
    if (error) throw new Error(`Invalid stored Design template ${entry}: ${error}`);
    own.push({ ...template, id: entry.slice(0, -5), own: true });
  }
  return [...BUILTIN_TEMPLATES.map((template) => ({ ...template, own: false })), ...own];
}
export async function saveDesignTemplate(dataDir: string, template: DesignTemplate): Promise<void> {
  const id = identifier(template.id);
  const error = templateStepsError(template.actions);
  if (error) throw new Error(error);
  await writeFile(path.join(dataDir, "templates", `${id}.json`), JSON.stringify(template), { encoding: "utf8", flag: "wx", mode: 0o600 });
}
export async function removeDesignTemplate(dataDir: string, id: string): Promise<void> {
  await unlink(path.join(dataDir, "templates", `${identifier(id)}.json`));
}
