// The known headless coding-agent CLIs, checked in priority order, plus the
// provider env var each one needs. Shared by `init` (detection) and `env
// list` (which provider variable to report on).

export const AGENT_TOOLS = ['claude', 'codex', 'openhands', 'aider'];

const HEADLESS_COMMAND = {
  claude: 'claude -p',
  codex: 'codex exec',
};

export const PROVIDER_VAR = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

export function headlessCommandFor(tool) {
  return HEADLESS_COMMAND[tool] ?? tool;
}

// Given a resolved `agent.command` (e.g. "claude -p"), recover which known
// tool it belongs to, so `env list` can report the right provider variable.
export function toolForCommand(command) {
  if (!command) return null;
  const bin = command.trim().split(/\s+/)[0];
  return AGENT_TOOLS.includes(bin) ? bin : null;
}
