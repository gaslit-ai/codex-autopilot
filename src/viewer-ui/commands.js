/** @param {string} value */
export function quoteShell(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** @param {string} threadId @param {string} prompt */
export function buildResumeCommand(threadId, prompt) {
  // GOTCHA: both values originate in run files. Quote IDs as well as prompts.
  return `codex exec resume ${quoteShell(threadId)} ${quoteShell(prompt)}`;
}
