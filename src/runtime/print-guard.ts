/**
 * `-p/--print` prompt-presence guard for bin/pico.ts.
 *
 * Refuses `pico -p` runs that would otherwise exit 0 silently with an empty
 * prompt (scripts passing an empty argument got a no-op run with no
 * diagnostic). Mirrors upstream's consumption rules: `-p` takes the NEXT
 * arg as its value only when it is not a flag; otherwise the prompt must be
 * a positional argument somewhere in the remaining argv (the subagent spawn
 * pattern is `-p --session <path> … "Task: …"`). Only when neither exists
 * is the run genuinely prompt-less.
 */

/** Value-taking flags whose value must not be mistaken for a prompt. */
const PRINT_VALUE_FLAGS: Record<string, true> = {
  "--session": true,
  "--model": true,
  "--tools": true,
  "--max-tokens": true,
  "--thinking": true,
  "--export": true,
  "--extension": true,
  "-e": true,
  "--skill": true,
  "--prompt-template": true,
  "--theme": true,
  "--system-prompt": true,
  "--append-system-prompt": true,
};

/** A prompt-able value: non-empty and not a flag / @file reference. */
function isPromptValue(arg: string | undefined): boolean {
  return (
    arg !== undefined && arg.trim().length > 0 && !arg.startsWith("@") && (!arg.startsWith("-") || arg.startsWith("---"))
  );
}

export function missingPrintPrompt(raw: string[]): boolean {
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (arg !== "-p" && arg !== "--print") continue;
    if (isPromptValue(raw[i + 1])) {
      i++; // consumed as the prompt value
      continue;
    }
    // No immediate value — scan the remaining args for a positional prompt,
    // skipping value-taking flags and their values.
    for (let j = i + 1; j < raw.length; j++) {
      const candidate = raw[j]!;
      if (PRINT_VALUE_FLAGS[candidate] && !candidate.includes("=") && isPromptValue(raw[j + 1])) {
        j++; // skip the flag's value
        continue;
      }
      if (isPromptValue(candidate)) return false;
    }
    return true; // -p present but no prompt anywhere in argv
  }
  return false;
}
