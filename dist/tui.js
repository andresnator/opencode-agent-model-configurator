// src/domain.ts
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var AGENT_LIST_ERROR = "This OpenCode server did not return an agent list (GET /agent). Update OpenCode and retry.";
async function resolveProfilesRoot(moduleUrl, configuredProfilesDir, baseDirectory = process.cwd()) {
  if (configuredProfilesDir) {
    if (configuredProfilesDir.startsWith("file://")) return fileURLToPath(configuredProfilesDir);
    if (configuredProfilesDir === "~") return homedir();
    if (configuredProfilesDir.startsWith(`~${path.sep}`)) {
      return path.join(homedir(), configuredProfilesDir.slice(2));
    }
    return path.resolve(baseDirectory, configuredProfilesDir);
  }
  return path.join(path.dirname(await realpath(fileURLToPath(moduleUrl))), "profiles");
}
function normalizeLiveAgents(result) {
  const root = isRecord(result) && "data" in result ? result.data : result;
  if (!Array.isArray(root)) throw new Error(AGENT_LIST_ERROR);
  const byName = /* @__PURE__ */ new Map();
  for (const entry of root) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
    const agent = {
      name: entry.name,
      mode: entry.mode === "primary" || entry.mode === "all" ? entry.mode : "subagent",
      native: entry.native === true,
      hidden: entry.hidden === true,
      taskRules: normalizeTaskRules(entry.permission)
    };
    if (typeof entry.description === "string" && entry.description.length > 0) agent.description = entry.description;
    byName.set(agent.name, agent);
  }
  return [...byName.values()].sort(byAgentName);
}
function visibleAgents(agents, showHidden) {
  return showHidden ? [...agents] : agents.filter((agent) => !agent.hidden);
}
function effectiveTaskAction(rules, subagent) {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (wildcardMatch(subagent, rules[index].pattern)) return rules[index];
  }
  return { pattern: "*", action: "allow" };
}
function buildAgentHierarchy(agents) {
  const parents = agents.filter((agent) => agent.mode === "primary" || agent.mode === "all");
  const delegable = agents.filter((agent) => agent.mode === "subagent" || agent.mode === "all");
  const claimed = /* @__PURE__ */ new Set();
  const groups = parents.map((parent) => {
    const children = [];
    for (const candidate of delegable) {
      if (candidate.name === parent.name) continue;
      const rule = effectiveTaskAction(parent.taskRules, candidate.name);
      if (rule.action === "deny" || rule.pattern === "*") continue;
      children.push(candidate);
      claimed.add(candidate.name);
    }
    return {
      parent,
      children: children.sort(byAgentName),
      openDelegation: catchAllTaskAction(parent.taskRules) !== "deny"
    };
  }).sort(
    (left, right) => Number(left.parent.native) - Number(right.parent.native) || left.parent.name.localeCompare(right.parent.name)
  );
  const otherSubagents = agents.filter((agent) => agent.mode === "subagent" && !claimed.has(agent.name)).sort(byAgentName);
  return { groups, otherSubagents };
}
function wildcardMatch(value, pattern) {
  if (pattern === "*") return true;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "s").test(value);
}
async function loadProfiles(profilesRoot, agents) {
  let entries;
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return { profiles: [], invalid: [] };
    throw error;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name));
  const profiles = [];
  const invalid = [];
  for (const file of files) {
    const profilePath = path.join(profilesRoot, file.name);
    let raw;
    try {
      raw = JSON.parse(await readFile(profilePath, "utf8"));
    } catch (error) {
      invalid.push({ path: profilePath, errors: [error instanceof Error ? error.message : "unreadable profile"] });
      continue;
    }
    const validation = validateProfile(raw, agents);
    if (!validation.profile) {
      invalid.push({ path: profilePath, errors: validation.errors });
      continue;
    }
    profiles.push({ path: profilePath, profile: validation.profile, warnings: validation.warnings });
  }
  return { profiles, invalid };
}
function validateProfile(raw, agents) {
  const errors = [];
  const warnings = [];
  if (!isRecord(raw)) return { errors: ["profile must be an object"], warnings };
  if (!isRecord(raw.tiers)) return { errors: ["profile must contain a tiers object"], warnings };
  const knownAgents = new Set(agents);
  const coveredAgents = /* @__PURE__ */ new Set();
  const tiers = {};
  for (const [tierName, tierValue] of Object.entries(raw.tiers)) {
    if (!isRecord(tierValue) || !Array.isArray(tierValue.agents)) {
      errors.push(`tier '${tierName}' must contain an agents array`);
      continue;
    }
    const tierAgents = tierValue.agents.filter((agent) => typeof agent === "string");
    if (tierAgents.length !== tierValue.agents.length) errors.push(`tier '${tierName}' contains a non-string agent`);
    const unknown = [];
    const knownTierAgents = [];
    for (const agent of tierAgents) {
      if (!knownAgents.has(agent)) {
        unknown.push(agent);
        continue;
      }
      if (coveredAgents.has(agent)) errors.push(`agent '${agent}' appears in more than one tier`);
      coveredAgents.add(agent);
      knownTierAgents.push(agent);
    }
    if (unknown.length > 0) warnings.push(`tier '${tierName}' skips agents missing on this server: ${unknown.join(", ")}`);
    const tier = {
      description: typeof tierValue.description === "string" ? tierValue.description : "",
      agents: knownTierAgents
    };
    if (typeof tierValue.variant === "string") tier.variant = tierValue.variant;
    tiers[tierName] = tier;
  }
  if (errors.length > 0) return { errors, warnings };
  return {
    profile: {
      name: typeof raw.name === "string" ? raw.name : "unnamed",
      description: typeof raw.description === "string" ? raw.description : "",
      tiers
    },
    errors,
    warnings
  };
}
function normalizeProviderCatalog(result) {
  const root = isRecord(result) && "data" in result ? result.data : result;
  if (!isRecord(root)) return [];
  const connected = new Set(
    Array.isArray(root.connected) ? root.connected.filter((provider) => typeof provider === "string") : []
  );
  const providers = Array.isArray(root.all) ? root.all : [];
  return providers.filter(isRecord).filter((provider) => typeof provider.id === "string" && connected.has(provider.id)).map((provider) => ({ id: provider.id, models: normalizeModels(provider.models) })).filter((provider) => provider.models.length > 0).sort((left, right) => left.id.localeCompare(right.id));
}
function flattenModels(providers) {
  return providers.flatMap(
    (provider) => provider.models.map((model) => ({ id: `${provider.id}/${model.id}`, variants: model.variants }))
  );
}
function calculateChanges(current, decisions) {
  const changes = [];
  for (const [agent, decision] of decisions) {
    if (decision.action === "keep") continue;
    const before = normalizeMapping(current[agent]);
    const after = decision.action === "inherit" ? {} : decision.variant ? { model: decision.model, variant: decision.variant } : { model: decision.model };
    if (sameMapping(before, after)) continue;
    changes.push({ agent, before, after, action: decision.action });
  }
  return changes.sort((left, right) => left.agent.localeCompare(right.agent));
}
function formatMapping(mapping) {
  if (!mapping.model) return "inherits";
  return mapping.variant ? `${mapping.model} @${mapping.variant}` : mapping.model;
}
function normalizeTaskRules(raw) {
  if (!Array.isArray(raw)) return [];
  const rules = [];
  for (const rule of raw) {
    if (!isRecord(rule) || typeof rule.permission !== "string" || typeof rule.pattern !== "string") continue;
    if (!wildcardMatch("task", rule.permission)) continue;
    if (rule.action !== "allow" && rule.action !== "deny" && rule.action !== "ask") continue;
    rules.push({ pattern: rule.pattern, action: rule.action });
  }
  return rules;
}
function catchAllTaskAction(rules) {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (rules[index].pattern === "*") return rules[index].action;
  }
  return "allow";
}
function byAgentName(left, right) {
  return left.name.localeCompare(right.name);
}
function isMissingPath(error) {
  const code = isRecord(error) ? error.code : void 0;
  return code === "ENOENT" || code === "ENOTDIR";
}
function normalizeModels(raw) {
  const entries = Array.isArray(raw) ? raw.filter(isRecord).map((model) => [model.id, model]) : isRecord(raw) ? Object.entries(raw) : [];
  return entries.filter((entry) => typeof entry[0] === "string" && isRecord(entry[1])).map(([id, model]) => ({ id, variants: normalizeVariants(model.variants) })).sort((left, right) => left.id.localeCompare(right.id));
}
function normalizeVariants(raw) {
  if (Array.isArray(raw)) return raw.filter((variant) => typeof variant === "string").sort();
  if (isRecord(raw)) return Object.keys(raw).sort();
  return [];
}
function normalizeMapping(mapping) {
  if (!mapping?.model) return {};
  return mapping.variant ? { model: mapping.model, variant: mapping.variant } : { model: mapping.model };
}
function sameMapping(left, right) {
  return left.model === right.model && left.variant === right.variant;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/options.ts
function normalizePluginOptions(raw) {
  if (!isRecord2(raw) || typeof raw.profilesDir !== "string") return {};
  const profilesDir = raw.profilesDir.trim();
  return profilesDir ? { profilesDir } : {};
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/persistence.ts
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile as readFile2, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import path2 from "node:path";

// node_modules/jsonc-parser/lib/esm/impl/scanner.js
function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value2 = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value2 = value2 * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value2 = value2 * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value2 = value2 * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value2 = -1;
    }
    return value2;
  }
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += "\n";
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "	";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += "\n";
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      // tokens: []{}:,
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      // strings
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      // comments
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      // numbers
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      // found a minus, followed by a number so
      // we fall through to proceed with scanning
      // numbers
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      // literals and unknown symbols
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  return {
    setPosition,
    getPosition: () => pos,
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: () => token,
    getTokenValue: () => value,
    getTokenOffset: () => tokenOffset,
    getTokenLength: () => pos - tokenOffset,
    getTokenStartLine: () => lineStartOffset,
    getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
    getTokenError: () => scanError
  };
}
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes2) {
  CharacterCodes2[CharacterCodes2["lineFeed"] = 10] = "lineFeed";
  CharacterCodes2[CharacterCodes2["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes2[CharacterCodes2["space"] = 32] = "space";
  CharacterCodes2[CharacterCodes2["_0"] = 48] = "_0";
  CharacterCodes2[CharacterCodes2["_1"] = 49] = "_1";
  CharacterCodes2[CharacterCodes2["_2"] = 50] = "_2";
  CharacterCodes2[CharacterCodes2["_3"] = 51] = "_3";
  CharacterCodes2[CharacterCodes2["_4"] = 52] = "_4";
  CharacterCodes2[CharacterCodes2["_5"] = 53] = "_5";
  CharacterCodes2[CharacterCodes2["_6"] = 54] = "_6";
  CharacterCodes2[CharacterCodes2["_7"] = 55] = "_7";
  CharacterCodes2[CharacterCodes2["_8"] = 56] = "_8";
  CharacterCodes2[CharacterCodes2["_9"] = 57] = "_9";
  CharacterCodes2[CharacterCodes2["a"] = 97] = "a";
  CharacterCodes2[CharacterCodes2["b"] = 98] = "b";
  CharacterCodes2[CharacterCodes2["c"] = 99] = "c";
  CharacterCodes2[CharacterCodes2["d"] = 100] = "d";
  CharacterCodes2[CharacterCodes2["e"] = 101] = "e";
  CharacterCodes2[CharacterCodes2["f"] = 102] = "f";
  CharacterCodes2[CharacterCodes2["g"] = 103] = "g";
  CharacterCodes2[CharacterCodes2["h"] = 104] = "h";
  CharacterCodes2[CharacterCodes2["i"] = 105] = "i";
  CharacterCodes2[CharacterCodes2["j"] = 106] = "j";
  CharacterCodes2[CharacterCodes2["k"] = 107] = "k";
  CharacterCodes2[CharacterCodes2["l"] = 108] = "l";
  CharacterCodes2[CharacterCodes2["m"] = 109] = "m";
  CharacterCodes2[CharacterCodes2["n"] = 110] = "n";
  CharacterCodes2[CharacterCodes2["o"] = 111] = "o";
  CharacterCodes2[CharacterCodes2["p"] = 112] = "p";
  CharacterCodes2[CharacterCodes2["q"] = 113] = "q";
  CharacterCodes2[CharacterCodes2["r"] = 114] = "r";
  CharacterCodes2[CharacterCodes2["s"] = 115] = "s";
  CharacterCodes2[CharacterCodes2["t"] = 116] = "t";
  CharacterCodes2[CharacterCodes2["u"] = 117] = "u";
  CharacterCodes2[CharacterCodes2["v"] = 118] = "v";
  CharacterCodes2[CharacterCodes2["w"] = 119] = "w";
  CharacterCodes2[CharacterCodes2["x"] = 120] = "x";
  CharacterCodes2[CharacterCodes2["y"] = 121] = "y";
  CharacterCodes2[CharacterCodes2["z"] = 122] = "z";
  CharacterCodes2[CharacterCodes2["A"] = 65] = "A";
  CharacterCodes2[CharacterCodes2["B"] = 66] = "B";
  CharacterCodes2[CharacterCodes2["C"] = 67] = "C";
  CharacterCodes2[CharacterCodes2["D"] = 68] = "D";
  CharacterCodes2[CharacterCodes2["E"] = 69] = "E";
  CharacterCodes2[CharacterCodes2["F"] = 70] = "F";
  CharacterCodes2[CharacterCodes2["G"] = 71] = "G";
  CharacterCodes2[CharacterCodes2["H"] = 72] = "H";
  CharacterCodes2[CharacterCodes2["I"] = 73] = "I";
  CharacterCodes2[CharacterCodes2["J"] = 74] = "J";
  CharacterCodes2[CharacterCodes2["K"] = 75] = "K";
  CharacterCodes2[CharacterCodes2["L"] = 76] = "L";
  CharacterCodes2[CharacterCodes2["M"] = 77] = "M";
  CharacterCodes2[CharacterCodes2["N"] = 78] = "N";
  CharacterCodes2[CharacterCodes2["O"] = 79] = "O";
  CharacterCodes2[CharacterCodes2["P"] = 80] = "P";
  CharacterCodes2[CharacterCodes2["Q"] = 81] = "Q";
  CharacterCodes2[CharacterCodes2["R"] = 82] = "R";
  CharacterCodes2[CharacterCodes2["S"] = 83] = "S";
  CharacterCodes2[CharacterCodes2["T"] = 84] = "T";
  CharacterCodes2[CharacterCodes2["U"] = 85] = "U";
  CharacterCodes2[CharacterCodes2["V"] = 86] = "V";
  CharacterCodes2[CharacterCodes2["W"] = 87] = "W";
  CharacterCodes2[CharacterCodes2["X"] = 88] = "X";
  CharacterCodes2[CharacterCodes2["Y"] = 89] = "Y";
  CharacterCodes2[CharacterCodes2["Z"] = 90] = "Z";
  CharacterCodes2[CharacterCodes2["asterisk"] = 42] = "asterisk";
  CharacterCodes2[CharacterCodes2["backslash"] = 92] = "backslash";
  CharacterCodes2[CharacterCodes2["closeBrace"] = 125] = "closeBrace";
  CharacterCodes2[CharacterCodes2["closeBracket"] = 93] = "closeBracket";
  CharacterCodes2[CharacterCodes2["colon"] = 58] = "colon";
  CharacterCodes2[CharacterCodes2["comma"] = 44] = "comma";
  CharacterCodes2[CharacterCodes2["dot"] = 46] = "dot";
  CharacterCodes2[CharacterCodes2["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes2[CharacterCodes2["minus"] = 45] = "minus";
  CharacterCodes2[CharacterCodes2["openBrace"] = 123] = "openBrace";
  CharacterCodes2[CharacterCodes2["openBracket"] = 91] = "openBracket";
  CharacterCodes2[CharacterCodes2["plus"] = 43] = "plus";
  CharacterCodes2[CharacterCodes2["slash"] = 47] = "slash";
  CharacterCodes2[CharacterCodes2["formFeed"] = 12] = "formFeed";
  CharacterCodes2[CharacterCodes2["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/jsonc-parser/lib/esm/impl/string-intern.js
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + " ".repeat(index);
    })
  },
  "	": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + "	".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "	".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + "	".repeat(index);
    })
  }
};
var supportedEols = ["\n", "\r", "\r\n"];

// node_modules/jsonc-parser/lib/esm/impl/format.js
function format(documentText, range, options) {
  let initialIndentLevel;
  let formatText;
  let formatTextStart;
  let rangeStart;
  let rangeEnd;
  if (range) {
    rangeStart = range.offset;
    rangeEnd = rangeStart + range.length;
    formatTextStart = rangeStart;
    while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
      formatTextStart--;
    }
    let endOffset = rangeEnd;
    while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
      endOffset++;
    }
    formatText = documentText.substring(formatTextStart, endOffset);
    initialIndentLevel = computeIndentLevel(formatText, options);
  } else {
    formatText = documentText;
    initialIndentLevel = 0;
    formatTextStart = 0;
    rangeStart = 0;
    rangeEnd = documentText.length;
  }
  const eol = getEOL(options, documentText);
  const eolFastPathSupported = supportedEols.includes(eol);
  let numberLineBreaks = 0;
  let indentLevel = 0;
  let indentValue;
  if (options.insertSpaces) {
    indentValue = cachedSpaces[options.tabSize || 4] ?? repeat(cachedSpaces[1], options.tabSize || 4);
  } else {
    indentValue = "	";
  }
  const indentType = indentValue === "	" ? "	" : " ";
  let scanner = createScanner(formatText, false);
  let hasError = false;
  function newLinesAndIndent() {
    if (numberLineBreaks > 1) {
      return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
    if (!eolFastPathSupported || amountOfSpaces > cachedBreakLinesWithSpaces[indentType][eol].length) {
      return eol + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    if (amountOfSpaces <= 0) {
      return eol;
    }
    return cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
  }
  function scanNext() {
    let token = scanner.scan();
    numberLineBreaks = 0;
    while (token === 15 || token === 14) {
      if (token === 14 && options.keepLines) {
        numberLineBreaks += 1;
      } else if (token === 14) {
        numberLineBreaks = 1;
      }
      token = scanner.scan();
    }
    hasError = token === 16 || scanner.getTokenError() !== 0;
    return token;
  }
  const editOperations = [];
  function addEdit(text, startOffset, endOffset) {
    if (!hasError && (!range || startOffset < rangeEnd && endOffset > rangeStart) && documentText.substring(startOffset, endOffset) !== text) {
      editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
    }
  }
  let firstToken = scanNext();
  if (options.keepLines && numberLineBreaks > 0) {
    addEdit(repeat(eol, numberLineBreaks), 0, 0);
  }
  if (firstToken !== 17) {
    let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
    let initialIndent = indentValue.length * initialIndentLevel < 20 && options.insertSpaces ? cachedSpaces[indentValue.length * initialIndentLevel] : repeat(indentValue, initialIndentLevel);
    addEdit(initialIndent, formatTextStart, firstTokenStart);
  }
  while (firstToken !== 17) {
    let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
    let secondToken = scanNext();
    let replaceContent = "";
    let needsLineBreak = false;
    while (numberLineBreaks === 0 && (secondToken === 12 || secondToken === 13)) {
      let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
      addEdit(cachedSpaces[1], firstTokenEnd, commentTokenStart);
      firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
      needsLineBreak = secondToken === 12;
      replaceContent = needsLineBreak ? newLinesAndIndent() : "";
      secondToken = scanNext();
    }
    if (secondToken === 2) {
      if (firstToken !== 1) {
        indentLevel--;
      }
      ;
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else if (secondToken === 4) {
      if (firstToken !== 3) {
        indentLevel--;
      }
      ;
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else {
      switch (firstToken) {
        case 3:
        case 1:
          indentLevel++;
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 5:
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 12:
          replaceContent = newLinesAndIndent();
          break;
        case 13:
          if (numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 6:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 10:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (secondToken === 6 && !needsLineBreak) {
            replaceContent = "";
          }
          break;
        case 7:
        case 8:
        case 9:
        case 11:
        case 2:
        case 4:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else {
            if ((secondToken === 12 || secondToken === 13) && !needsLineBreak) {
              replaceContent = cachedSpaces[1];
            } else if (secondToken !== 5 && secondToken !== 17) {
              hasError = true;
            }
          }
          break;
        case 16:
          hasError = true;
          break;
      }
      if (numberLineBreaks > 0 && (secondToken === 12 || secondToken === 13)) {
        replaceContent = newLinesAndIndent();
      }
    }
    if (secondToken === 17) {
      if (options.keepLines && numberLineBreaks > 0) {
        replaceContent = newLinesAndIndent();
      } else {
        replaceContent = options.insertFinalNewline ? eol : "";
      }
    }
    const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
    addEdit(replaceContent, firstTokenEnd, secondTokenStart);
    firstToken = secondToken;
  }
  return editOperations;
}
function repeat(s, count) {
  let result = "";
  for (let i = 0; i < count; i++) {
    result += s;
  }
  return result;
}
function computeIndentLevel(content, options) {
  let i = 0;
  let nChars = 0;
  const tabSize = options.tabSize || 4;
  while (i < content.length) {
    let ch = content.charAt(i);
    if (ch === cachedSpaces[1]) {
      nChars++;
    } else if (ch === "	") {
      nChars += tabSize;
    } else {
      break;
    }
    i++;
  }
  return Math.floor(nChars / tabSize);
}
function getEOL(options, text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (i + 1 < text.length && text.charAt(i + 1) === "\n") {
        return "\r\n";
      }
      return "\r";
    } else if (ch === "\n") {
      return "\n";
    }
  }
  return options && options.eol || "\n";
}
function isEOL(text, offset) {
  return "\r\n".indexOf(text.charAt(offset)) !== -1;
}

// node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions2) {
  ParseOptions2.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parse(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentProperty = null;
  let currentParent = [];
  const previousParents = [];
  function onValue(value) {
    if (Array.isArray(currentParent)) {
      currentParent.push(value);
    } else if (currentProperty !== null) {
      currentParent[currentProperty] = value;
    }
  }
  const visitor = {
    onObjectBegin: () => {
      const object = {};
      onValue(object);
      previousParents.push(currentParent);
      currentParent = object;
      currentProperty = null;
    },
    onObjectProperty: (name) => {
      currentProperty = name;
    },
    onObjectEnd: () => {
      currentParent = previousParents.pop();
    },
    onArrayBegin: () => {
      const array = [];
      onValue(array);
      previousParents.push(currentParent);
      currentParent = array;
      currentProperty = null;
    },
    onArrayEnd: () => {
      currentParent = previousParents.pop();
    },
    onLiteralValue: onValue,
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  return currentParent[0];
}
function parseTree(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentParent = { type: "array", offset: -1, length: -1, children: [], parent: void 0 };
  function ensurePropertyComplete(endOffset) {
    if (currentParent.type === "property") {
      currentParent.length = endOffset - currentParent.offset;
      currentParent = currentParent.parent;
    }
  }
  function onValue(valueNode) {
    currentParent.children.push(valueNode);
    return valueNode;
  }
  const visitor = {
    onObjectBegin: (offset) => {
      currentParent = onValue({ type: "object", offset, length: -1, parent: currentParent, children: [] });
    },
    onObjectProperty: (name, offset, length) => {
      currentParent = onValue({ type: "property", offset, length: -1, parent: currentParent, children: [] });
      currentParent.children.push({ type: "string", value: name, offset, length, parent: currentParent });
    },
    onObjectEnd: (offset, length) => {
      ensurePropertyComplete(offset + length);
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onArrayBegin: (offset, length) => {
      currentParent = onValue({ type: "array", offset, length: -1, parent: currentParent, children: [] });
    },
    onArrayEnd: (offset, length) => {
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onLiteralValue: (value, offset, length) => {
      onValue({ type: getNodeType(value), offset, length, parent: currentParent, value });
      ensurePropertyComplete(offset + length);
    },
    onSeparator: (sep, offset, length) => {
      if (currentParent.type === "property") {
        if (sep === ":") {
          currentParent.colonOffset = offset;
        } else if (sep === ",") {
          ensurePropertyComplete(offset);
        }
      }
    },
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  const result = currentParent.children[0];
  if (result) {
    delete result.parent;
  }
  return result;
}
function findNodeAtLocation(root, path4) {
  if (!root) {
    return void 0;
  }
  let node = root;
  for (let segment of path4) {
    if (typeof segment === "string") {
      if (node.type !== "object" || !Array.isArray(node.children)) {
        return void 0;
      }
      let found = false;
      for (const propertyNode of node.children) {
        if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
          node = propertyNode.children[1];
          found = true;
          break;
        }
      }
      if (!found) {
        return void 0;
      }
    } else {
      const index = segment;
      if (node.type !== "array" || index < 0 || !Array.isArray(node.children) || index >= node.children.length) {
        return void 0;
      }
      node = node.children[index];
    }
  }
  return node;
}
function visit(text, visitor, options = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options && options.disallowComments;
  const allowTrailingComma = options && options.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(
            14
            /* ParseErrorCode.InvalidUnicode */
          );
          break;
        case 5:
          handleError(
            15
            /* ParseErrorCode.InvalidEscapeCharacter */
          );
          break;
        case 3:
          handleError(
            13
            /* ParseErrorCode.UnexpectedEndOfNumber */
          );
          break;
        case 1:
          if (!disallowComments) {
            handleError(
              11
              /* ParseErrorCode.UnexpectedEndOfComment */
            );
          }
          break;
        case 2:
          handleError(
            12
            /* ParseErrorCode.UnexpectedEndOfString */
          );
          break;
        case 6:
          handleError(
            16
            /* ParseErrorCode.InvalidCharacter */
          );
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(
              10
              /* ParseErrorCode.InvalidCommentToken */
            );
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(
            1
            /* ParseErrorCode.InvalidSymbol */
          );
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  function parseString(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(
            2
            /* ParseErrorCode.InvalidNumberFormat */
          );
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
      return false;
    }
    parseString(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
    } else {
      handleError(5, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
    }
    _jsonPath.pop();
    return true;
  }
  function parseObject() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [
        2
        /* SyntaxKind.CloseBraceToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseArray() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [
          4,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [
        4
        /* SyntaxKind.CloseBracketToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray();
      case 1:
        return parseObject();
      case 10:
        return parseString(true);
      default:
        return parseLiteral();
    }
  }
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}
function getNodeType(value) {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object": {
      if (!value) {
        return "null";
      } else if (Array.isArray(value)) {
        return "array";
      }
      return "object";
    }
    default:
      return "null";
  }
}

// node_modules/jsonc-parser/lib/esm/impl/edit.js
function setProperty(text, originalPath, value, options) {
  const path4 = originalPath.slice();
  const errors = [];
  const root = parseTree(text, errors);
  let parent = void 0;
  let lastSegment = void 0;
  while (path4.length > 0) {
    lastSegment = path4.pop();
    parent = findNodeAtLocation(root, path4);
    if (parent === void 0 && value !== void 0) {
      if (typeof lastSegment === "string") {
        value = { [lastSegment]: value };
      } else {
        value = [value];
      }
    } else {
      break;
    }
  }
  if (!parent) {
    if (value === void 0) {
      throw new Error("Can not delete in empty document");
    }
    return withFormatting(text, { offset: root ? root.offset : 0, length: root ? root.length : 0, content: JSON.stringify(value) }, options);
  } else if (parent.type === "object" && typeof lastSegment === "string" && Array.isArray(parent.children)) {
    const existing = findNodeAtLocation(parent, [lastSegment]);
    if (existing !== void 0) {
      if (value === void 0) {
        if (!existing.parent) {
          throw new Error("Malformed AST");
        }
        const propertyIndex = parent.children.indexOf(existing.parent);
        let removeBegin;
        let removeEnd = existing.parent.offset + existing.parent.length;
        if (propertyIndex > 0) {
          let previous = parent.children[propertyIndex - 1];
          removeBegin = previous.offset + previous.length;
        } else {
          removeBegin = parent.offset + 1;
          if (parent.children.length > 1) {
            let next = parent.children[1];
            removeEnd = next.offset;
          }
        }
        return withFormatting(text, { offset: removeBegin, length: removeEnd - removeBegin, content: "" }, options);
      } else {
        return withFormatting(text, { offset: existing.offset, length: existing.length, content: JSON.stringify(value) }, options);
      }
    } else {
      if (value === void 0) {
        return [];
      }
      const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
      const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map((p) => p.children[0].value)) : parent.children.length;
      let edit2;
      if (index > 0) {
        let previous = parent.children[index - 1];
        edit2 = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      } else if (parent.children.length === 0) {
        edit2 = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        edit2 = { offset: parent.offset + 1, length: 0, content: newProperty + "," };
      }
      return withFormatting(text, edit2, options);
    }
  } else if (parent.type === "array" && typeof lastSegment === "number" && Array.isArray(parent.children)) {
    const insertIndex = lastSegment;
    if (insertIndex === -1) {
      const newProperty = `${JSON.stringify(value)}`;
      let edit2;
      if (parent.children.length === 0) {
        edit2 = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        const previous = parent.children[parent.children.length - 1];
        edit2 = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit2, options);
    } else if (value === void 0 && parent.children.length >= 0) {
      const removalIndex = lastSegment;
      const toRemove = parent.children[removalIndex];
      let edit2;
      if (parent.children.length === 1) {
        edit2 = { offset: parent.offset + 1, length: parent.length - 2, content: "" };
      } else if (parent.children.length - 1 === removalIndex) {
        let previous = parent.children[removalIndex - 1];
        let offset = previous.offset + previous.length;
        let parentEndOffset = parent.offset + parent.length;
        edit2 = { offset, length: parentEndOffset - 2 - offset, content: "" };
      } else {
        edit2 = { offset: toRemove.offset, length: parent.children[removalIndex + 1].offset - toRemove.offset, content: "" };
      }
      return withFormatting(text, edit2, options);
    } else if (value !== void 0) {
      let edit2;
      const newProperty = `${JSON.stringify(value)}`;
      if (!options.isArrayInsertion && parent.children.length > lastSegment) {
        const toModify = parent.children[lastSegment];
        edit2 = { offset: toModify.offset, length: toModify.length, content: newProperty };
      } else if (parent.children.length === 0 || lastSegment === 0) {
        edit2 = { offset: parent.offset + 1, length: 0, content: parent.children.length === 0 ? newProperty : newProperty + "," };
      } else {
        const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
        const previous = parent.children[index - 1];
        edit2 = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit2, options);
    } else {
      throw new Error(`Can not ${value === void 0 ? "remove" : options.isArrayInsertion ? "insert" : "modify"} Array index ${insertIndex} as length is not sufficient`);
    }
  } else {
    throw new Error(`Can not add ${typeof lastSegment !== "number" ? "index" : "property"} to parent of type ${parent.type}`);
  }
}
function withFormatting(text, edit2, options) {
  if (!options.formattingOptions) {
    return [edit2];
  }
  let newText = applyEdit(text, edit2);
  let begin = edit2.offset;
  let end = edit2.offset + edit2.content.length;
  if (edit2.length === 0 || edit2.content.length === 0) {
    while (begin > 0 && !isEOL(newText, begin - 1)) {
      begin--;
    }
    while (end < newText.length && !isEOL(newText, end)) {
      end++;
    }
  }
  const edits = format(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit3 = edits[i];
    newText = applyEdit(newText, edit3);
    begin = Math.min(begin, edit3.offset);
    end = Math.max(end, edit3.offset + edit3.length);
    end += edit3.content.length - edit3.length;
  }
  const editLength = text.length - (newText.length - end) - begin;
  return [{ offset: begin, length: editLength, content: newText.substring(begin, end) }];
}
function applyEdit(text, edit2) {
  return text.substring(0, edit2.offset) + edit2.content + text.substring(edit2.offset + edit2.length);
}

// node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError2) {
  ScanError2[ScanError2["None"] = 0] = "None";
  ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind2) {
  SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
  SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
  SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
  SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
  SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parse2 = parse;
var ParseErrorCode;
(function(ParseErrorCode2) {
  ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function printParseErrorCode(code) {
  switch (code) {
    case 1:
      return "InvalidSymbol";
    case 2:
      return "InvalidNumberFormat";
    case 3:
      return "PropertyNameExpected";
    case 4:
      return "ValueExpected";
    case 5:
      return "ColonExpected";
    case 6:
      return "CommaExpected";
    case 7:
      return "CloseBraceExpected";
    case 8:
      return "CloseBracketExpected";
    case 9:
      return "EndOfFileExpected";
    case 10:
      return "InvalidCommentToken";
    case 11:
      return "UnexpectedEndOfComment";
    case 12:
      return "UnexpectedEndOfString";
    case 13:
      return "UnexpectedEndOfNumber";
    case 14:
      return "InvalidUnicode";
    case 15:
      return "InvalidEscapeCharacter";
    case 16:
      return "InvalidCharacter";
  }
  return "<unknown ParseErrorCode>";
}
function modify(text, path4, value, options) {
  return setProperty(text, path4, value, options);
}
function applyEdits(text, edits) {
  let sortedEdits = edits.slice(0).sort((a, b) => {
    const diff = a.offset - b.offset;
    if (diff === 0) {
      return a.length - b.length;
    }
    return diff;
  });
  let lastModifiedOffset = text.length;
  for (let i = sortedEdits.length - 1; i >= 0; i--) {
    let e = sortedEdits[i];
    if (e.offset + e.length <= lastModifiedOffset) {
      text = applyEdit(text, e);
    } else {
      throw new Error("Overlapping edit");
    }
    lastModifiedOffset = e.offset;
  }
  return text;
}

// src/persistence.ts
var CONFIG_JSON = "opencode.json";
var CONFIG_JSONC = "opencode.jsonc";
var DEFAULT_FILE_MODE = 384;
var FORMATTING_OPTIONS = { insertSpaces: true, tabSize: 2, eol: "\n" };
async function resolveConfigFile(scope, runtime) {
  const root = scope === "global" ? globalConfigRoot(runtime) : projectConfigRoot(runtime);
  const jsonc = path2.join(root, CONFIG_JSONC);
  const json = path2.join(root, CONFIG_JSON);
  if (await exists(jsonc)) return jsonc;
  if (await exists(json)) return json;
  return json;
}
async function readConfigSnapshot(file) {
  try {
    const [content, metadata] = await Promise.all([readFile2(file, "utf8"), stat(file)]);
    const config = parseConfig(content, file);
    return { file, exists: true, content, mode: metadata.mode & 511, mappings: extractMappings(config) };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { file, exists: false, content: "{}\n", mode: DEFAULT_FILE_MODE, mappings: {} };
  }
}
function renderConfigChanges(snapshot, changes) {
  let content = snapshot.content;
  for (const change of changes) {
    if (change.action === "inherit") {
      content = edit(content, ["agent", change.agent, "model"], void 0);
      content = edit(content, ["agent", change.agent, "variant"], void 0);
      const parsed2 = parseConfig(content, snapshot.file);
      const agent = isRecord3(parsed2.agent) && isRecord3(parsed2.agent[change.agent]) ? parsed2.agent[change.agent] : void 0;
      if (agent && Object.keys(agent).length === 0) content = edit(content, ["agent", change.agent], void 0);
    } else {
      content = edit(content, ["agent", change.agent, "model"], change.after.model);
      content = edit(content, ["agent", change.agent, "variant"], change.after.variant);
    }
  }
  const parsed = parseConfig(content, snapshot.file);
  if (isRecord3(parsed.agent) && Object.keys(parsed.agent).length === 0) content = edit(content, ["agent"], void 0);
  parseConfig(content, snapshot.file);
  return content;
}
async function writeConfigChanges(snapshot, changes, hooks = {}) {
  if (changes.length === 0) return { file: snapshot.file };
  const rendered = renderConfigChanges(snapshot, changes);
  if (rendered === snapshot.content) return { file: snapshot.file };
  await mkdir(path2.dirname(snapshot.file), { recursive: true, mode: 448 });
  if (snapshot.exists) {
    const current = await readFile2(snapshot.file, "utf8");
    if (current !== snapshot.content) throw new Error(`${snapshot.file} changed while the configurator was open; reload and retry`);
  } else if (await exists(snapshot.file)) {
    throw new Error(`${snapshot.file} was created while the configurator was open; reload and retry`);
  }
  const suffix = `${timestamp()}-${randomBytes(3).toString("hex")}`;
  const temporary = `${snapshot.file}.${suffix}.tmp`;
  try {
    await hooks.before?.("temporary-open");
    const handle = await open(temporary, "wx", snapshot.mode || DEFAULT_FILE_MODE);
    try {
      await hooks.before?.("temporary-write");
      await handle.writeFile(rendered, "utf8");
      await hooks.before?.("temporary-flush");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.before?.("rename");
    await rename(temporary, snapshot.file);
    await chmodFile(snapshot.file, snapshot.mode || DEFAULT_FILE_MODE);
    await hooks.before?.("destination-flush");
    await syncFile(snapshot.file);
    await syncDirectory(path2.dirname(snapshot.file));
    await hooks.before?.("post-validate");
    const persisted = await readFile2(snapshot.file, "utf8");
    parseConfig(persisted, snapshot.file);
    if (persisted !== rendered) throw new Error(`${snapshot.file} did not persist the expected content`);
    return { file: snapshot.file };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => void 0);
    if (snapshot.exists) await writeFile(snapshot.file, snapshot.content, { mode: snapshot.mode }).catch(() => void 0);
    else await rm(snapshot.file, { force: true }).catch(() => void 0);
    throw error;
  }
}
function higherPrecedenceWarning() {
  if (process.env.OPENCODE_CONFIG_CONTENT) return "OPENCODE_CONFIG_CONTENT can override values written here";
  if (process.env.OPENCODE_CONFIG) return "OPENCODE_CONFIG can override values written here";
  return void 0;
}
function globalConfigRoot(runtime) {
  if (runtime.config) return runtime.config;
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  return path2.join(xdgConfig || path2.join(homedir2(), ".config"), "opencode");
}
function projectConfigRoot(runtime) {
  const root = runtime.worktree && runtime.worktree !== "/" ? runtime.worktree : runtime.directory;
  return path2.join(root, ".opencode");
}
function displayConfigFile(scope, file, runtime) {
  if (scope === "project") {
    const projectRoot = path2.dirname(projectConfigRoot(runtime));
    const relative = path2.relative(projectRoot, file);
    return relative.startsWith("..") ? file : relative;
  }
  const home = homedir2();
  if (file === home) return "~";
  if (file.startsWith(`${home}${path2.sep}`)) return `~${file.slice(home.length)}`;
  return file;
}
function extractMappings(config) {
  if (!isRecord3(config.agent)) return {};
  const mappings = {};
  for (const [agent, value] of Object.entries(config.agent)) {
    if (!isRecord3(value)) continue;
    const model = typeof value.model === "string" ? value.model : void 0;
    const variant = typeof value.variant === "string" ? value.variant : void 0;
    mappings[agent] = { model, variant };
  }
  return mappings;
}
function edit(content, jsonPath, value) {
  return applyEdits(content, modify(content, jsonPath, value, { formattingOptions: FORMATTING_OPTIONS }));
}
function parseConfig(content, file) {
  const errors = [];
  const parsed = parse2(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`${file}:${first.offset}: ${printParseErrorCode(first.error)}`);
  }
  if (!isRecord3(parsed)) throw new Error(`${file}: configuration root must be an object`);
  return parsed;
}
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
async function chmodFile(file, mode) {
  const handle = await open(file, "r+");
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}
async function syncFile(file) {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function timestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error) {
  return isRecord3(error) && error.code === "ENOENT";
}

// src/hot-apply.ts
async function applyConfigChanges(client, scope, runtime, snapshot, changes) {
  if (scope === "project") {
    const result2 = await writeConfigChanges(snapshot, changes);
    const hot2 = await disposeProjectInstance(client, runtime);
    return outcome(result2.file, hot2);
  }
  const plan = planGlobalHotApply(changes);
  if (plan.strategy === "write-only") {
    const result2 = await writeConfigChanges(snapshot, changes);
    return { file: result2.file, hotApplied: false, detail: plan.reason };
  }
  await writeConfigChanges(snapshot, plan.preludeChanges);
  const hot = await patchGlobalConfig(client, plan.patch);
  if (hot.applied) return { file: snapshot.file, hotApplied: true };
  const fresh = await readConfigSnapshot(snapshot.file);
  const result = await writeConfigChanges(fresh, plan.fallbackChanges);
  return outcome(result.file, hot);
}
function planGlobalHotApply(changes) {
  const sets = changes.filter((change) => change.action === "set" && change.after.model !== void 0);
  const effective = sets.some(
    (change) => change.after.model !== change.before.model || change.after.variant !== void 0 && change.after.variant !== change.before.variant
  );
  if (!effective) {
    return { strategy: "write-only", reason: "removal-only changes cannot be hot-applied at global scope" };
  }
  const preludeChanges = changes.filter((change) => change.action === "inherit");
  for (const change of sets) {
    if (change.before.variant === void 0 || change.after.variant !== void 0 || change.before.model === void 0) continue;
    preludeChanges.push({ agent: change.agent, before: change.before, after: { model: change.before.model }, action: "set" });
  }
  const agent = {};
  for (const change of sets) {
    const model = change.after.model;
    if (model === void 0) continue;
    agent[change.agent] = change.after.variant === void 0 ? { model } : { model, variant: change.after.variant };
  }
  return { strategy: "patch", preludeChanges, patch: { agent }, fallbackChanges: sets };
}
async function disposeProjectInstance(client, runtime) {
  const instance = asHotApplyClient(client)?.instance;
  if (typeof instance?.dispose !== "function") {
    return { applied: false, reason: "this OpenCode client does not expose instance disposal" };
  }
  const directory = runtime.directory || runtime.worktree;
  if (!directory) return { applied: false, reason: "the project instance directory is unknown" };
  try {
    const result = await instance.dispose({ directory });
    if (result?.error !== void 0 || result?.data !== true) {
      return { applied: false, reason: rejectionReason("instance disposal", result) };
    }
    return { applied: true };
  } catch (error) {
    return { applied: false, reason: errorReason(error) };
  }
}
async function patchGlobalConfig(client, patch) {
  const config = asHotApplyClient(client)?.global?.config;
  if (typeof config?.update !== "function") {
    return { applied: false, reason: "this OpenCode client does not expose the global config route" };
  }
  try {
    const result = await config.update({ config: patch });
    if (result?.error !== void 0 || result?.data === void 0) {
      return { applied: false, reason: rejectionReason("global config update", result) };
    }
    return { applied: true };
  } catch (error) {
    return { applied: false, reason: errorReason(error) };
  }
}
function outcome(file, hot) {
  return hot.applied ? { file, hotApplied: true } : { file, hotApplied: false, detail: hot.reason };
}
function asHotApplyClient(client) {
  return typeof client === "object" && client !== null ? client : void 0;
}
function rejectionReason(operation, result) {
  const status = result?.response?.status;
  return typeof status === "number" ? `${operation} failed with status ${status}` : `${operation} was rejected`;
}
function errorReason(error) {
  return error instanceof Error ? error.message : "unknown hot-apply error";
}

// src/presets.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { mkdir as mkdir2, open as open2, readFile as readFile3, rename as rename2, rm as rm2 } from "node:fs/promises";
import path3 from "node:path";
var PRESETS_FILE = "model-configurator-presets.json";
var PRESETS_VERSION = 1;
var DEFAULT_FILE_MODE2 = 384;
var PRESET_DOCUMENT_KEYS = ["version", "presets"];
var PRESET_KEYS = ["name", "savedAt", "assignments"];
var ASSIGNMENT_KEYS = ["model", "variant"];
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function presetsFile(runtime) {
  return path3.join(globalConfigRoot(runtime), PRESETS_FILE);
}
async function loadPresets(file) {
  let content;
  try {
    content = await readFile3(file, "utf8");
  } catch (error) {
    if (isMissing2(error)) return [];
    throw unreadablePresetStorage(file, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidPresetStorage(file, "malformed JSON");
  }
  if (!isRecord4(parsed)) throw invalidPresetStorage(file, "root must be an object");
  assertExactKeys(parsed, PRESET_DOCUMENT_KEYS, "root", file);
  if (!Object.hasOwn(parsed, "version")) throw invalidPresetStorage(file, "version is missing");
  if (typeof parsed.version !== "number") throw invalidPresetStorage(file, "version must be numeric");
  if (parsed.version !== PRESETS_VERSION) {
    throw invalidPresetStorage(file, `unsupported version ${String(parsed.version)}`);
  }
  if (!Object.hasOwn(parsed, "presets")) throw invalidPresetStorage(file, "presets is missing");
  if (!Array.isArray(parsed.presets)) throw invalidPresetStorage(file, "presets must be an array");
  const presets = [];
  const names = /* @__PURE__ */ new Set();
  for (const [index, raw] of parsed.presets.entries()) {
    const preset = validatePreset(raw, index, file);
    if (names.has(preset.name)) {
      throw invalidPresetStorage(file, `duplicate preset name '${preset.name}' at presets[${index}].name`);
    }
    names.add(preset.name);
    presets.push(preset);
  }
  return presets.sort((left, right) => left.name.localeCompare(right.name));
}
async function savePreset(file, preset) {
  const existing = await loadPresets(file);
  const next = existing.filter((entry) => entry.name !== preset.name);
  next.push(preset);
  next.sort((left, right) => left.name.localeCompare(right.name));
  await writePresets(file, next);
}
async function deletePreset(file, name) {
  const existing = await loadPresets(file);
  const next = existing.filter((entry) => entry.name !== name);
  if (next.length === existing.length) return;
  await writePresets(file, next);
}
function partitionPresetAssignments(assignments, agents, models) {
  const knownAgents = new Set(agents);
  const live = new Map(models.map((model) => [model.id, new Set(model.variants)]));
  const valid = {};
  const stale = [];
  for (const [agent, assignment] of Object.entries(assignments)) {
    const variants = live.get(assignment.model);
    const usable = knownAgents.has(agent) && variants !== void 0 && (!assignment.variant || variants.has(assignment.variant));
    if (usable) valid[agent] = assignment;
    else stale.push(agent);
  }
  stale.sort();
  return { valid, stale };
}
async function writePresets(file, presets) {
  const rendered = `${JSON.stringify({ version: PRESETS_VERSION, presets }, null, 2)}
`;
  const directory = path3.dirname(file);
  await mkdir2(directory, { recursive: true, mode: 448 });
  const suffix = `${timestamp2()}-${randomBytes2(3).toString("hex")}`;
  const temporary = `${file}.${suffix}.tmp`;
  try {
    const handle = await open2(temporary, "wx", DEFAULT_FILE_MODE2);
    try {
      await handle.writeFile(rendered, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename2(temporary, file);
    await syncDirectory2(directory);
  } catch (error) {
    await rm2(temporary, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function syncDirectory2(directory) {
  const handle = await open2(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function validatePreset(raw, index, file) {
  const presetPath = `presets[${index}]`;
  if (!isRecord4(raw)) throw invalidPresetStorage(file, `${presetPath} must be an object`);
  assertExactKeys(raw, PRESET_KEYS, presetPath, file);
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw invalidPresetStorage(file, `${presetPath}.name must be a non-empty string`);
  }
  if (typeof raw.savedAt !== "string") throw invalidPresetStorage(file, `${presetPath}.savedAt must be a string`);
  if (!Object.hasOwn(raw, "assignments")) {
    throw invalidPresetStorage(file, `${presetPath}.assignments is missing`);
  }
  if (!isRecord4(raw.assignments)) {
    throw invalidPresetStorage(file, `${presetPath}.assignments must be an object`);
  }
  for (const agent of Object.keys(raw.assignments)) {
    if (FORBIDDEN_KEYS.has(agent)) {
      throw invalidPresetStorage(file, `${presetPath}.assignments: forbidden key '${agent}'`);
    }
    const value = raw.assignments[agent];
    const assignmentPath = `${presetPath}.assignments.${agent}`;
    if (!isRecord4(value)) throw invalidPresetStorage(file, `${assignmentPath} must be an object`);
    assertExactKeys(value, ASSIGNMENT_KEYS, assignmentPath, file);
    if (typeof value.model !== "string" || value.model.length === 0) {
      throw invalidPresetStorage(file, `${assignmentPath}.model must be a non-empty string`);
    }
    if (Object.hasOwn(value, "variant") && typeof value.variant !== "string") {
      throw invalidPresetStorage(file, `${assignmentPath}.variant must be a string`);
    }
  }
  return {
    name: raw.name,
    savedAt: raw.savedAt,
    assignments: raw.assignments
  };
}
function assertExactKeys(value, expectedKeys, location, file) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw invalidPresetStorage(file, `${location}: forbidden key '${key}'`);
    if (!expectedKeys.includes(key)) throw invalidPresetStorage(file, `${location}: unknown field '${key}'`);
  }
}
function invalidPresetStorage(file, reason) {
  throw new Error(`Invalid preset storage at ${file}: ${reason}`);
}
function unreadablePresetStorage(file, error) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Unable to read preset storage at ${file}: ${reason}`);
}
function timestamp2() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing2(error) {
  return isRecord4(error) && error.code === "ENOENT";
}

// src/wizard.tsx
var DONE = "__done__";
var ALL_AGENTS = "__all_agents__";
var KEEP_CURRENT = "__keep_current__";
var USE_TIER = "__use_tier__";
var INHERIT = "__inherit__";
var NO_VARIANT = "__no_variant__";
var NEXT_AGENT = "__next_agent__";
var PREV_AGENT = "__prev_agent__";
var OVERRIDE_YES = "__override_yes__";
var OVERRIDE_NO = "__override_no__";
var APPLY = "__apply__";
var APPLY_SAVE = "__apply_save__";
var CANCEL = "__cancel__";
var APPLY_PRESET = "__apply_preset__";
var DELETE_PRESET = "__delete_preset__";
var OVERWRITE_PRESET = "__overwrite_preset__";
var RENAME_PRESET = "__rename_preset__";
var PRESET_PREFIX = "__preset__:";
var GROUP_PREFIX = "__group__:";
var OTHER_GROUP = "__other_subagents__";
var TOGGLE_HIDDEN = "__toggle_hidden__";
var REVIEW_CHANGES = "__review_changes__";
var BACK_HINT = "esc: back";
var CLOSE_HINT = "esc: close";
var AGENTS_HINT = "esc: back to agents";
var OTHER_GROUP_TITLE = "Other subagents";
var configuratorRunning = false;
async function runModelConfigurator(api, profilesRoot) {
  if (configuratorRunning) {
    api.ui.toast({ variant: "warning", message: "The model configurator is already open." });
    return;
  }
  configuratorRunning = true;
  const previousDialogSize = api.ui.dialog.size;
  try {
    if (!api.state.ready || !api.state.path.directory) {
      api.ui.toast({ variant: "warning", message: "OpenCode paths are still syncing. Try again in a moment." });
      return;
    }
    api.ui.dialog.setSize("large");
    const agents = await loadAgents(api);
    if (agents.length === 0) {
      api.ui.toast({ variant: "warning", message: "This OpenCode server reported no agents to configure." });
      return;
    }
    const { profiles, invalid } = await loadProfiles(profilesRoot, agents.map((agent) => agent.name));
    for (const entry of invalid) {
      api.ui.toast({ variant: "warning", message: `Skipped profile ${entry.path}: ${entry.errors.join("; ")}` });
    }
    const presetsPath = presetsFile(api.state.path);
    let presets = [];
    let presetStorageAvailable = true;
    try {
      presets = await loadPresets(presetsPath);
    } catch (error) {
      presetStorageAvailable = false;
      api.ui.toast({
        variant: "warning",
        message: `Preset storage unavailable at ${presetsPath}: ${errorMessage(error)} Repair the file and reopen the configurator.`
      });
    }
    const catalog = await loadCatalog(api);
    if (catalog.length === 0) {
      api.ui.toast({ variant: "warning", message: "No connected providers with models are available. Connect one and retry." });
      return;
    }
    const models = flattenModels(catalog);
    const state = { agents, profiles, presets, presetStorageAvailable, models, presetsPath, showHidden: false };
    await runSteps(api, state);
  } catch (error) {
    api.ui.toast({ variant: "error", title: "Model configurator failed", message: errorMessage(error), duration: 8e3 });
  } finally {
    api.ui.dialog.clear();
    api.ui.dialog.setSize(previousDialogSize);
    configuratorRunning = false;
  }
}
async function runSteps(api, state) {
  const steps = [
    { run: (s) => runScopeStep(api, s) },
    { run: (s) => runHubStep(api, s) },
    { skip: (s) => s.source?.kind !== "profile", run: (s) => runTiersStep(api, s) },
    { skip: (s) => s.source?.kind !== "profile", run: (s) => runOverridesStep(api, s) },
    { run: (s) => runReviewStep(api, s) }
  ];
  let index = 0;
  let direction = 1;
  while (index >= 0 && index < steps.length) {
    const step = steps[index];
    if (step.skip?.(state)) {
      index += direction;
      continue;
    }
    const outcome2 = await step.run(state);
    if (outcome2 === "exit" || outcome2 === "done") return;
    direction = outcome2 === "next" ? 1 : -1;
    index += direction;
  }
}
async function runScopeStep(api, state) {
  const [projectFile, globalFile] = await Promise.all([
    resolveConfigFile("project", api.state.path),
    resolveConfigFile("global", api.state.path)
  ]);
  const warning = higherPrecedenceWarning();
  const suffix = warning ? ` \u2014 ${warning}` : "";
  const scope = await select(
    api,
    "Configuration scope",
    [
      { title: "Project", value: "project", description: `${displayConfigFile("project", projectFile, api.state.path)}${suffix}` },
      { title: "Global", value: "global", description: `${displayConfigFile("global", globalFile, api.state.path)}${suffix}` }
    ],
    CLOSE_HINT,
    state.scope
  );
  if (!scope) return "exit";
  state.scope = scope;
  state.configFile = scope === "project" ? projectFile : globalFile;
  state.snapshot = await readConfigSnapshot(state.configFile);
  return "next";
}
async function runHubStep(api, state) {
  while (true) {
    const pending = state.decisions?.size ?? 0;
    const options = [];
    if (pending > 0) {
      options.push({
        title: `Review ${pending} pending change${pending === 1 ? "" : "s"}`,
        value: REVIEW_CHANGES,
        description: "Continue to the apply confirmation"
      });
    }
    const sections = hubSections(state);
    for (const section of sections) {
      options.push({
        title: section.title,
        value: GROUP_PREFIX + section.key,
        description: section.description,
        category: "Agents"
      });
    }
    const hiddenCount = state.agents.filter((agent) => agent.hidden).length;
    if (hiddenCount > 0) {
      options.push({
        title: state.showHidden ? "Hide internal agents" : "Show internal agents",
        value: TOGGLE_HIDDEN,
        description: `${hiddenCount} agent${hiddenCount === 1 ? "" : "s"} OpenCode marks as internal`,
        category: "Agents"
      });
    }
    for (const file of state.profiles) {
      options.push({
        title: file.profile.name,
        value: file.profile.name,
        description: file.profile.description,
        category: "Profiles"
      });
    }
    for (const preset of state.presets) {
      const count = Object.keys(preset.assignments).length;
      const saved = preset.savedAt ? ` \u2014 saved ${preset.savedAt.slice(0, 10)}` : "";
      options.push({
        title: preset.name,
        value: PRESET_PREFIX + preset.name,
        description: `${count} agent${count === 1 ? "" : "s"}${saved}`,
        category: "Saved presets"
      });
    }
    const selected = await select(api, "Agents", options, BACK_HINT);
    if (!selected) return "back";
    if (selected === TOGGLE_HIDDEN) {
      state.showHidden = !state.showHidden;
      continue;
    }
    if (selected === REVIEW_CHANGES) {
      state.source = { kind: "agents" };
      return "next";
    }
    if (selected.startsWith(GROUP_PREFIX)) {
      const key = selected.slice(GROUP_PREFIX.length);
      const section = sections.find((entry) => entry.key === key);
      if (section) await runGroupAgentsLoop(api, state, section);
      continue;
    }
    if (selected.startsWith(PRESET_PREFIX)) {
      const name = selected.slice(PRESET_PREFIX.length);
      const preset = state.presets.find((entry) => entry.name === name);
      if (!preset) continue;
      const outcome2 = await handlePresetChoice(api, state, preset);
      if (outcome2 === "reshow") continue;
      return outcome2;
    }
    const profileFile = state.profiles.find((file) => file.profile.name === selected);
    if (!profileFile) continue;
    for (const warning of profileFile.warnings) api.ui.toast({ variant: "warning", message: warning });
    state.source = { kind: "profile" };
    state.selectedProfile = profileFile;
    return "next";
  }
}
function hubSections(state) {
  const hierarchy = buildAgentHierarchy(visibleAgents(state.agents, state.showHidden));
  const sections = hierarchy.groups.map((group) => ({
    key: group.parent.name,
    title: group.parent.name,
    description: sectionDescription(group.children.length, group.openDelegation),
    agents: [group.parent, ...group.children]
  }));
  const others = hierarchy.otherSubagents;
  if (others.length > 0) {
    sections.push({
      key: OTHER_GROUP,
      title: OTHER_GROUP_TITLE,
      description: `${others.length} subagent${others.length === 1 ? "" : "s"} no primary delegates to explicitly`,
      agents: others
    });
  }
  return sections;
}
function sectionDescription(children, openDelegation) {
  if (children === 0) return openDelegation ? "Delegates to any subagent" : "No delegates";
  const base = `${children} subagent${children === 1 ? "" : "s"}`;
  return openDelegation ? `${base} + any other subagent` : base;
}
async function runGroupAgentsLoop(api, state, section) {
  const agents = section.agents;
  const decisions = state.decisions ??= /* @__PURE__ */ new Map();
  const current = state.snapshot.mappings;
  while (true) {
    const selected = await select(
      api,
      section.title,
      [
        { title: "Done", value: DONE },
        { title: "All agents", value: ALL_AGENTS, description: "Set model/variant for every agent in this group" },
        ...agents.map((agent) => ({
          title: decisions.has(agent.name) ? `\u25CF ${agent.name}` : agent.name,
          value: agent.name,
          description: `${modeLetter(agent.mode)} ${decisionDisplay(decisions.get(agent.name), current[agent.name])}`
        }))
      ],
      AGENTS_HINT
    );
    if (!selected || selected === DONE) return;
    if (selected === ALL_AGENTS) {
      const summary = agents.map((agent) => `${agent.name}: ${formatMapping(current[agent.name] ?? {})}`).join("; ");
      const decision2 = await selectDecision(api, `Configure every agent in ${section.title}`, state.models, void 0, summary);
      if (decision2 === void 0) continue;
      if (decision2.action === "keep") for (const agent of agents) decisions.delete(agent.name);
      else for (const agent of agents) decisions.set(agent.name, decision2);
      continue;
    }
    const decision = await selectDecision(
      api,
      `Configure: ${selected}`,
      state.models,
      void 0,
      formatMapping(current[selected] ?? {})
    );
    if (decision === void 0) continue;
    if (decision.action === "keep") decisions.delete(selected);
    else decisions.set(selected, decision);
  }
}
async function handlePresetChoice(api, state, preset) {
  const count = Object.keys(preset.assignments).length;
  const action = await select(
    api,
    `Preset: ${preset.name}`,
    [
      { title: "Apply", value: APPLY_PRESET, description: `${count} agent${count === 1 ? "" : "s"}` },
      { title: "Delete", value: DELETE_PRESET, description: "Remove this saved preset" }
    ],
    BACK_HINT
  );
  if (!action) return "reshow";
  if (action === DELETE_PRESET) {
    try {
      await deletePreset(state.presetsPath, preset.name);
    } catch (error) {
      state.presets = [];
      state.presetStorageAvailable = false;
      api.ui.toast({ variant: "error", title: "Preset not deleted", message: errorMessage(error), duration: 8e3 });
      return "reshow";
    }
    state.presets = state.presets.filter((entry) => entry.name !== preset.name);
    api.ui.toast({ variant: "success", message: `Deleted preset "${preset.name}".` });
    return "reshow";
  }
  const { valid, stale } = partitionPresetAssignments(preset.assignments, state.agents.map((agent) => agent.name), state.models);
  if (Object.keys(valid).length === 0) {
    api.ui.toast({ variant: "warning", message: `Preset "${preset.name}" has no entries that match the live catalog.` });
    return "reshow";
  }
  if (stale.length > 0) {
    const proceed = await confirmStep(
      api,
      "Preset has stale entries",
      `These no longer match the live catalog and will be skipped: ${stale.join(", ")}. Apply the rest?`
    );
    if (!proceed) return "reshow";
  }
  const decisions = /* @__PURE__ */ new Map();
  for (const [agent, assignment] of Object.entries(valid)) {
    decisions.set(agent, { action: "set", model: assignment.model, variant: assignment.variant });
  }
  state.decisions = decisions;
  state.tierDecisions = /* @__PURE__ */ new Map();
  state.source = { kind: "preset" };
  return "next";
}
async function runTiersStep(api, state) {
  const profile = state.selectedProfile.profile;
  const current = state.snapshot.mappings;
  const tiers = Object.entries(profile.tiers).filter(([, tier]) => tier.agents.length > 0);
  const tierDecisions = /* @__PURE__ */ new Map();
  let i = 0;
  while (i < tiers.length) {
    const [tierName, tier] = tiers[i];
    const currentSummary = tier.agents.map((agent) => `${agent}: ${formatMapping(current[agent] ?? {})}`).join("; ");
    const decision = await selectDecision(api, `Tier: ${tierName}`, state.models, tier.variant, currentSummary);
    if (decision === void 0) {
      if (i === 0) return "back";
      i -= 1;
      for (const agent of tiers[i][1].agents) tierDecisions.delete(agent);
      continue;
    }
    if (decision.action !== "keep") for (const agent of tier.agents) tierDecisions.set(agent, decision);
    else for (const agent of tier.agents) tierDecisions.delete(agent);
    i += 1;
  }
  state.tierDecisions = tierDecisions;
  state.decisions = new Map(tierDecisions);
  return "next";
}
async function runOverridesStep(api, state) {
  while (true) {
    const wants = await select(
      api,
      "Individual overrides",
      [
        { title: "Yes, override individual agents", value: OVERRIDE_YES },
        { title: "No, apply tier decisions as-is", value: OVERRIDE_NO }
      ],
      BACK_HINT
    );
    if (wants === void 0) return "back";
    if (wants === OVERRIDE_NO) return "next";
    if (await runAgentOverrideLoop(api, state)) return "next";
  }
}
async function runAgentOverrideLoop(api, state) {
  const agents = visibleAgents(state.agents, state.showHidden).map((agent) => agent.name);
  const decisions = state.decisions;
  const tierDecisions = state.tierDecisions;
  const current = state.snapshot.mappings;
  let focus;
  while (true) {
    let selected;
    if (focus) {
      selected = focus;
      focus = void 0;
    } else {
      selected = await select(
        api,
        "Choose agent to override",
        [
          { title: "Done", value: DONE },
          ...agents.map((agent) => ({ title: agent, value: agent, description: decisionDisplay(decisions.get(agent), current[agent]) }))
        ],
        BACK_HINT
      );
      if (!selected) return false;
      if (selected === DONE) return true;
    }
    const agentIndex = agents.indexOf(selected);
    const action = await select(
      api,
      `Override: ${selected}`,
      [
        { title: "\u2192 Next agent", value: NEXT_AGENT },
        { title: "\u2190 Prev agent", value: PREV_AGENT },
        { title: "Use tier decision", value: USE_TIER, description: decisionDisplay(tierDecisions.get(selected), current[selected]) },
        { title: "Keep current", value: KEEP_CURRENT, description: formatMapping(current[selected] ?? {}) },
        { title: "Inherit", value: INHERIT, description: "Remove model and variant at this scope" },
        ...state.models.map((model) => ({ title: model.id, value: model.id, description: variantDescription(model) }))
      ],
      BACK_HINT
    );
    if (!action) continue;
    if (action === NEXT_AGENT) {
      focus = agents[(agentIndex + 1) % agents.length];
      continue;
    }
    if (action === PREV_AGENT) {
      focus = agents[(agentIndex - 1 + agents.length) % agents.length];
      continue;
    }
    if (action === USE_TIER) {
      const tier = tierDecisions.get(selected);
      if (tier) decisions.set(selected, tier);
      else decisions.delete(selected);
    } else if (action === KEEP_CURRENT) {
      decisions.delete(selected);
    } else if (action === INHERIT) {
      decisions.set(selected, { action: "inherit" });
    } else {
      const model = state.models.find((candidate) => candidate.id === action);
      if (!model) continue;
      const variant = await selectVariant(api, model);
      if (variant === void 0) {
        focus = selected;
        continue;
      }
      decisions.set(selected, { action: "set", model: model.id, variant: variant || void 0 });
    }
  }
}
async function runReviewStep(api, state) {
  const snapshot = state.snapshot;
  const decisions = state.decisions;
  const changes = calculateChanges(snapshot.mappings, decisions);
  if (changes.length === 0) {
    api.ui.toast({ variant: "info", message: "No model assignment changes selected." });
    return "back";
  }
  const refreshedModels = flattenModels(await loadCatalog(api));
  const stale = findStaleSelections(decisions, refreshedModels);
  if (stale.length > 0) {
    api.ui.toast({ variant: "warning", message: `Selections changed in the live catalog: ${stale.join(", ")}. Reopen and select again.` });
    return "exit";
  }
  const warning = higherPrecedenceWarning();
  const categoryOf = reviewCategories(state.agents);
  const rows = [...changes].sort(
    (left, right) => (categoryOf.get(left.agent) ?? "other").localeCompare(categoryOf.get(right.agent) ?? "other") || left.agent.localeCompare(right.agent)
  );
  const title = `Apply ${changes.length} model change${changes.length === 1 ? "" : "s"}?`;
  const choice = await select(
    api,
    title,
    [
      { title: "Apply", value: APPLY, description: warning || void 0 },
      {
        title: "Apply and save as preset",
        value: APPLY_SAVE,
        description: state.presetStorageAvailable ? void 0 : "Repair preset storage and reopen the configurator to enable saving.",
        disabled: !state.presetStorageAvailable
      },
      { title: "Cancel", value: CANCEL },
      ...rows.map((change) => ({
        title: change.agent,
        value: `__change__:${change.agent}`,
        description: `${formatMapping(change.before)} -> ${formatMapping(change.after)}`,
        category: categoryOf.get(change.agent) ?? "other",
        disabled: true
      }))
    ],
    BACK_HINT
  );
  if (!choice) return "back";
  if (choice === CANCEL) return "done";
  if (choice !== APPLY && choice !== APPLY_SAVE) return "back";
  if (choice === APPLY_SAVE && !state.presetStorageAvailable) return "back";
  let presetName;
  if (choice === APPLY_SAVE) {
    presetName = await promptPresetName(api, state);
    if (presetName === void 0) return "back";
  }
  const result = await applyConfigChanges(api.client, state.scope, api.state.path, snapshot, changes);
  api.ui.toast({
    variant: "success",
    title: "Agent models updated",
    message: result.hotApplied ? `Wrote ${result.file}. Applied live to this OpenCode server; other running OpenCode processes still need a restart.` : `Wrote ${result.file}. Restart OpenCode sessions to apply the assignments (${result.detail}).`,
    duration: 8e3
  });
  if (presetName !== void 0) {
    try {
      const assignments = resolvePresetAssignments(snapshot.mappings, changes, state.agents.map((agent) => agent.name));
      await savePreset(state.presetsPath, { name: presetName, savedAt: (/* @__PURE__ */ new Date()).toISOString(), assignments });
      api.ui.toast({ variant: "success", message: `Saved preset "${presetName}".` });
    } catch (error) {
      state.presetStorageAvailable = false;
      api.ui.toast({ variant: "error", title: "Preset not saved", message: errorMessage(error), duration: 8e3 });
    }
  }
  return "done";
}
async function promptPresetName(api, state) {
  while (true) {
    const name = await prompt(api, "Preset name", "Name this preset");
    if (name === void 0) return void 0;
    const trimmed = name.trim();
    if (!trimmed) {
      api.ui.toast({ variant: "warning", message: "Preset name cannot be empty." });
      continue;
    }
    if (state.presets.some((entry) => entry.name === trimmed)) {
      const choice = await select(
        api,
        `Overwrite preset "${trimmed}"?`,
        [
          { title: "Overwrite", value: OVERWRITE_PRESET, description: "Replace the saved preset" },
          { title: "Choose another name", value: RENAME_PRESET }
        ],
        BACK_HINT
      );
      if (choice !== OVERWRITE_PRESET) continue;
    }
    return trimmed;
  }
}
function resolvePresetAssignments(current, changes, knownAgents) {
  const known = new Set(knownAgents);
  const resolved = { ...current };
  for (const change of changes) resolved[change.agent] = change.after;
  const assignments = {};
  for (const [agent, mapping] of Object.entries(resolved)) {
    if (!known.has(agent) || !mapping.model) continue;
    assignments[agent] = mapping.variant ? { model: mapping.model, variant: mapping.variant } : { model: mapping.model };
  }
  return assignments;
}
async function selectDecision(api, title, models, suggestedVariant, currentSummary) {
  while (true) {
    const action = await select(
      api,
      title,
      [
        { title: "Keep current", value: KEEP_CURRENT, description: currentSummary },
        { title: "Inherit", value: INHERIT, description: "Remove model and variant at this scope" },
        ...models.map((model2) => ({ title: model2.id, value: model2.id, description: variantDescription(model2) }))
      ],
      BACK_HINT
    );
    if (!action) return void 0;
    if (action === KEEP_CURRENT) return { action: "keep" };
    if (action === INHERIT) return { action: "inherit" };
    const model = models.find((candidate) => candidate.id === action);
    if (!model) return void 0;
    const variant = await selectVariant(api, model, suggestedVariant);
    if (variant === void 0) continue;
    return { action: "set", model: model.id, variant: variant || void 0 };
  }
}
async function selectVariant(api, model, suggested) {
  if (model.variants.length === 0) return "";
  const selected = await select(
    api,
    `Variant for ${model.id}`,
    [
      // Distinct from a provider-supplied "none" variant, which is a real value (e.g. OpenAI's reasoning-off tier).
      { title: "Default (no variant)", value: NO_VARIANT, description: "Do not write a variant key \u2014 inherit the provider default" },
      ...model.variants.map((variant) => ({ title: variant, value: variant }))
    ],
    BACK_HINT,
    suggested && model.variants.includes(suggested) ? suggested : NO_VARIANT
  );
  if (selected === void 0) return void 0;
  return selected === NO_VARIANT ? "" : selected;
}
async function loadCatalog(api) {
  const result = await api.client.provider.list();
  return normalizeProviderCatalog(result);
}
async function loadAgents(api) {
  const app = api.client.app;
  if (typeof app?.agents !== "function") {
    throw new Error("This OpenCode server does not expose the agent list (GET /agent). Update OpenCode and retry.");
  }
  return normalizeLiveAgents(await app.agents({ directory: api.state.path.directory }));
}
function reviewCategories(agents) {
  const hierarchy = buildAgentHierarchy(agents);
  const category = /* @__PURE__ */ new Map();
  for (const group of hierarchy.groups) category.set(group.parent.name, group.parent.name);
  for (const group of hierarchy.groups) {
    for (const child of group.children) {
      if (!category.has(child.name)) category.set(child.name, group.parent.name);
    }
  }
  for (const agent of hierarchy.otherSubagents) {
    if (!category.has(agent.name)) category.set(agent.name, OTHER_GROUP_TITLE);
  }
  return category;
}
function findStaleSelections(decisions, models) {
  const live = new Map(models.map((model) => [model.id, new Set(model.variants)]));
  const stale = /* @__PURE__ */ new Set();
  for (const decision of decisions.values()) {
    if (decision.action !== "set") continue;
    const variants = live.get(decision.model);
    if (!variants || decision.variant && !variants.has(decision.variant)) stale.add(decision.model);
  }
  return [...stale].sort();
}
function modeLetter(mode) {
  if (mode === "primary") return "M";
  return mode === "all" ? "A" : "S";
}
function decisionDisplay(decision, current) {
  if (!decision || decision.action === "keep") return `= ${formatMapping(current ?? {})}`;
  if (decision.action === "inherit") return "\u2192 inherit";
  return `\u2192 ${formatMapping({ model: decision.model, variant: decision.variant })}`;
}
function variantDescription(model) {
  return model.variants.length === 0 ? "No variants" : `${model.variants.length} variant${model.variants.length === 1 ? "" : "s"}`;
}
function select(api, title, options, placeholder = BACK_HINT, current) {
  return new Promise((resolve) => {
    const DialogSelect = api.ui.DialogSelect;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    api.ui.dialog.replace(
      () => DialogSelect({
        title,
        options,
        current,
        placeholder,
        onSelect: (option) => {
          finish(option.value);
          api.ui.dialog.clear();
        }
      }),
      () => finish(void 0)
    );
  });
}
function confirmStep(api, title, message) {
  return new Promise((resolve) => {
    const DialogConfirm = api.ui.DialogConfirm;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      api.ui.dialog.clear();
      resolve(value);
    };
    api.ui.dialog.replace(
      () => DialogConfirm({ title, message: `${message}

${BACK_HINT}`, onConfirm: () => finish(true), onCancel: () => finish(false) }),
      () => finish(void 0)
    );
  });
}
function prompt(api, title, placeholder) {
  return new Promise((resolve) => {
    const DialogPrompt = api.ui.DialogPrompt;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      api.ui.dialog.clear();
      resolve(value);
    };
    api.ui.dialog.replace(
      () => DialogPrompt({ title, placeholder, onConfirm: (value) => finish(value), onCancel: () => finish(void 0) }),
      () => finish(void 0)
    );
  });
}
function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown model configurator error";
}

// src/tui.tsx
var MODEL_CONFIGURATOR_PLUGIN_ID = "andresnator.agent-model-configurator";
var MODEL_CONFIGURATOR_COMMAND_ID = "andresnator.agent-model-configurator.open";
var MODEL_CONFIGURATOR_SLASH_NAME = "model-configurator";
var MINIMUM_OPENCODE_VERSION = "1.17.15";
var tui = async (api, rawOptions) => {
  const options = normalizePluginOptions(rawOptions);
  api.keymap.registerLayer({
    commands: [
      {
        name: MODEL_CONFIGURATOR_COMMAND_ID,
        title: "Configure agent models",
        desc: "Assign OpenCode models and variants by tier or agent",
        category: "Agent Models",
        namespace: "palette",
        slashName: MODEL_CONFIGURATOR_SLASH_NAME,
        run() {
          void resolveProfilesRoot(import.meta.url, options.profilesDir, api.state.path.directory).then((profilesRoot) => runModelConfigurator(api, profilesRoot)).catch((error) => {
            api.ui.toast({
              variant: "error",
              title: "Model configurator failed",
              message: String(error instanceof Error ? error.message : error),
              duration: 8e3
            });
          });
        }
      }
    ]
  });
};
var plugin = {
  id: MODEL_CONFIGURATOR_PLUGIN_ID,
  tui
};
var tui_default = plugin;
export {
  MINIMUM_OPENCODE_VERSION,
  MODEL_CONFIGURATOR_COMMAND_ID,
  MODEL_CONFIGURATOR_PLUGIN_ID,
  MODEL_CONFIGURATOR_SLASH_NAME,
  tui_default as default
};
