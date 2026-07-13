import path from "path";

function normalizePath(value) {
  try { return path.resolve(value); } catch { return ""; }
}

function tokenizeCommand(command) {
  const tokens = [];
  let token = "";
  let quote = "";
  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (token) tokens.push(token);
  return tokens;
}

export function matchesRecordedProcess({ command, cwd, expectedPath }) {
  if (!expectedPath || !command) return false;
  const expected = normalizePath(expectedPath);
  const tokens = tokenizeCommand(command);
  const scriptIndex = tokens.findIndex((token) => {
    if (!token) return false;
    if (path.isAbsolute(token)) return normalizePath(token) === expected;
    return !!cwd && normalizePath(path.join(cwd, token)) === expected;
  });
  const runtimeName = path.basename(tokens[0] || "").toLowerCase();
  const isNodeRuntime = runtimeName === "node" || runtimeName === "node.exe" || runtimeName === path.basename(process.execPath).toLowerCase();
  if (isNodeRuntime && scriptIndex > 0 && tokens.slice(1, scriptIndex).every((token) => token.startsWith("-"))) {
    return true;
  }

  const expectedName = path.basename(expectedPath);
  const isBundledServer = expectedName === "server.js" || expectedName === "custom-server.js";
  if (!isBundledServer || !/^next-server(?:\s|\(|$)/.test(command.trim())) return false;
  return !!cwd && normalizePath(cwd) === normalizePath(path.dirname(expectedPath));
}
