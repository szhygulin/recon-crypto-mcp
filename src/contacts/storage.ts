/**
 * Atomic read/write for `~/.vaultpilot-mcp/contacts.json`. Mirrors the
 * existing `atomicWriteJson` pattern in `src/setup/register-clients.ts`
 * — write to `.tmp`, rename. POSIX rename is atomic on the same FS;
 * Windows rename across same-volume overwrite is atomic too. File
 * mode 0o600 (config dir is 0o700).
 *
 * Symlink rejection: matches `writeUserConfig` — if the target path
 * exists and `lstat` shows a symlink, we refuse. Catches the case
 * where a malicious actor replaces `contacts.json` with a symlink to
 * a privileged file.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/user-config.js";
import {
  ContactsFile,
  emptyContactsFile,
  type ContactsFile as ContactsFileT,
} from "./schemas.js";

export function contactsPath(): string {
  return join(getConfigDir(), "contacts.json");
}

/**
 * Read the contacts file, validating against the schema. Returns the
 * empty shape on first-run (file missing) and on parse/schema failure
 * — corruption is treated as "start fresh", not "halt the server".
 * Callers that want the strict-fail behavior (e.g., the verifier)
 * call `readContactsStrict()`.
 */
export function readContactsFile(): ContactsFileT {
  const path = contactsPath();
  if (!existsSync(path)) return emptyContactsFile();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return ContactsFile.parse(parsed);
  } catch {
    // First-time-corrupt installs from before this schema landed
    // would otherwise crash the whole server. Returning empty lets
    // `add_contact` overwrite cleanly; the verifier still surfaces
    // the previous-load failure via its own path.
    return emptyContactsFile();
  }
}

/**
 * Strict read — throws on parse / schema failure. Used by the
 * verifier so a corrupted file surfaces as `CONTACTS_TAMPERED`
 * rather than being silently substituted with an empty file.
 */
export function readContactsStrict(): ContactsFileT {
  const path = contactsPath();
  if (!existsSync(path)) return emptyContactsFile();
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  return ContactsFile.parse(parsed);
}

export function writeContactsFile(file: ContactsFileT): void {
  const path = contactsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `Refusing to write contacts file at ${path}: target is a symlink. ` +
        `Investigate before deleting; this could be benign user setup or a ` +
        `tamper attempt.`,
    );
  }
  // Validate before writing so we never persist a broken shape.
  ContactsFile.parse(file);
  const tmp = `${path}.vaultpilot.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
