/**
 * Normalizes Claude Code's string-typed error results into stable signatures.
 * Sourced from observed `toolUseResult` strings; anything unrecognized becomes
 * "generic_error" so detectors never key on raw text.
 */
const SIGNATURES: Array<[RegExp, string]> = [
  [/^User rejected tool use/i, "user_rejected"],
  [/doesn't want to proceed with this tool use/i, "user_rejected"],
  [/String to replace not found in file/i, "edit_string_not_found"],
  [/Found \d+ matches of the string to replace/i, "edit_string_not_unique"],
  [/File has not been read yet/i, "file_not_read"],
  [/has been modified since it was last read/i, "file_modified_since_read"],
  [/File does not exist/i, "file_not_found"],
  [/no such file or directory/i, "file_not_found"],
  [/^Error: Exit code \d+/i, "exit_code_nonzero"],
  [/Command timed out/i, "command_timeout"],
  [/^\[Request interrupted by user/i, "user_interrupt"],
  [/InputValidationError/i, "input_validation"],
  [/permission/i, "permission_error"],
];

export function classifyError(text: string | undefined): string {
  if (!text) return "generic_error";
  for (const [pattern, signature] of SIGNATURES) {
    if (pattern.test(text)) return signature;
  }
  return "generic_error";
}

/** Tools whose successful execution can change external state. */
export const STATE_CHANGING_TOOLS = new Set([
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** Read-only tools for delegation analysis. */
export const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
