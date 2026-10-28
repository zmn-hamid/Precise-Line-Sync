import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) =>
  JSON.parse(readFileSync(resolve(root, name), "utf8"));

const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const requiredManifestKeys = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author",
  "isDesktopOnly",
];

for (const key of requiredManifestKeys) {
  if (!(key in manifest)) {
    throw new Error(`manifest.json is missing required key: ${key}`);
  }
}

if (!/^[a-z0-9-]+$/.test(manifest.id)) {
  throw new Error(`Invalid plugin id: ${manifest.id}`);
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`Invalid plugin version: ${manifest.version}`);
}
if (manifest.description.length > 250) {
  throw new Error("manifest description must be 250 characters or fewer");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error(
    `versions.json must map ${manifest.version} to ${manifest.minAppVersion}`,
  );
}

for (const file of ["main.js", "manifest.json", "README.md", "LICENSE"]) {
  const path = resolve(root, file);
  if (!statSync(path).isFile()) throw new Error(`Missing release file: ${file}`);
}

execFileSync(process.execPath, ["--check", resolve(root, "main.js")], {
  stdio: "inherit",
});

console.log(
  `Release validation passed for ${manifest.id} ${manifest.version} (Obsidian >= ${manifest.minAppVersion}).`,
);
