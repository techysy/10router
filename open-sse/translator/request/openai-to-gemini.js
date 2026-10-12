import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { DEFAULT_THINKING_AG_SIGNATURE, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { openaiToClaudeRequestForAntigravity } from "./openai-to-claude.js";
function generateUUID() {
  return crypto.randomUUID();
}

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity,
  toGeminiParameters,
  normalizeGeminiContents
} from "../formats/gemini.js";
import { createGeminiToolNamer, attachToolNameMap } from "../concerns/geminiTools.js";
import { deriveSessionId, toNumericSessionId } from "../../utils/sessionManager.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";

// Declared tool names, in declaration order. Registered with the namer before
// history so a collision rename lands on the history-only name, not a live tool.
function declaredToolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map(t => (t?.name && t.input_schema ? t.name : t?.type === OPENAI_BLOCK.FUNCTION ? t.function?.name : null))
    .filter(Boolean);
}

// Core: Convert OpenAI request to Gemini format (base for all variants)
function openaiToGeminiBase(model, body, stream, signature = DEFAULT_THINKING_AG_SIGNATURE) {
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS
  };
  const toolNamer = createGeminiToolNamer();
  for (const name of declaredToolNames(body.tools)) toolNamer.name(name);

  // Generation config
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  if (body.max_tokens !== undefined) {
    result.generationConfig.maxOutputTokens = body.max_tokens;
  }

  // Build tool_call_id -> name map and deduplicate duplicate tool_call_ids
  const tcID2Name = {};
  const tcIdCount = new Map();
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === OPENAI_BLOCK.FUNCTION && tc.id && tc.function?.name) {
            tcID2Name[tc.id] = tc.function.name;
          }
        }
      }
    }
  }

  // Build tool responses cache (queue-based in case of duplicate IDs)
  const toolResponses = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.TOOL && msg.tool_call_id) {
        if (!toolResponses[msg.tool_call_id]) {
          toolResponses[msg.tool_call_id] = [];
        }
        toolResponses[msg.tool_call_id].push(msg.content);
      }
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const role = msg.role;
      const content = msg.content;

      if (role === ROLE.SYSTEM && body.messages.length > 1) {
        result.systemInstruction = {
          role: GEMINI_ROLE.USER,
          parts: [{ text: typeof content === "string" ? content : extractTextContent(content) }]
        };
      } else if (role === ROLE.USER || (role === ROLE.SYSTEM && body.messages.length === 1)) {
        const parts = convertOpenAIContentToParts(content);
        if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.ASSISTANT) {
        const parts = [];

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content) {
          parts.push({
            thought: true,
            text: msg.reasoning_content
          });
          parts.push({
            thoughtSignature: signature,
            text: ""
          });
        }

        if (content) {
          const text = typeof content === "string" ? content : extractTextContent(content);
          if (text) {
            parts.push({ text });
          }
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const toolCallPairs = [];
          for (const tc of msg.tool_calls) {
            if (tc.type !== OPENAI_BLOCK.FUNCTION) continue;

            const args = tryParseJSON(tc.function?.arguments || "{}");
            const rawId = tc.id || "";
            let uniqueId = rawId;
            const seenCount = tcIdCount.get(rawId) || 0;
            tcIdCount.set(rawId, seenCount + 1);
            if (seenCount > 0) {
              uniqueId = `${rawId}_dup${seenCount}`;
            }

            parts.push({
              thoughtSignature: signature,
              functionCall: {
                id: uniqueId,
                name: toolNamer.name(tc.function.name),
                args: args
              }
            });
            toolCallPairs.push({ rawId, uniqueId });
          }

          if (parts.length > 0) {
            result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
          }

          // Check if there are actual tool responses in the next messages.
          // An empty-string result is still a result: tools with no output send
          // "", and fixMissingToolResponses fills unanswered calls with "".
          // Dropping those left a functionCall without its functionResponse (400).
          const hasActualResponses = toolCallPairs.some(({ rawId }) => toolResponses[rawId]?.length > 0);

          if (hasActualResponses) {
            const toolParts = [];
            for (const { rawId, uniqueId } of toolCallPairs) {
              if (!toolResponses[rawId] || toolResponses[rawId].length === 0) continue;

              let name = tcID2Name[rawId];
              if (!name) {
                const idParts = rawId.split("-");
                if (idParts.length > 2) {
                  name = idParts.slice(0, -2).join("-");
                } else {
                  name = rawId;
                }
              }

              let resp = toolResponses[rawId].shift() ?? "";
              let parsedResp = tryParseJSON(resp);
              if (parsedResp === null) {
                parsedResp = { result: resp };
              } else if (typeof parsedResp !== "object") {
                parsedResp = { result: parsedResp };
              }

              toolParts.push({
                functionResponse: {
                  id: uniqueId,
                  name: toolNamer.name(name),
                  response: { result: parsedResp }
                }
              });
            }
            if (toolParts.length > 0) {
              result.contents.push({ role: GEMINI_ROLE.USER, parts: toolParts });
            }
          }
        } else if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
        }
      }
    }
  }

  // Convert tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      // Check if already in Anthropic/Claude format (no type field, direct name/description/input_schema)
      if (t.name && t.input_schema) {
        functionDeclarations.push({
          name: toolNamer.name(t.name),
          description: t.description || "",
          parameters: toGeminiParameters(t.input_schema)
        });
      }
      // OpenAI format
      else if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
        const fn = t.function;
        functionDeclarations.push({
          name: toolNamer.name(fn.name),
          description: fn.description || "",
          parameters: toGeminiParameters(fn.parameters)
        });
      }
    }

    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  // #4345：首/尾回合守卫 —— 以 model 轮收尾（含未响应的 functionCall）会被
  // Google 拒绝 400 "Requests ending with a model turn are not supported"。
  result.contents = normalizeGeminiContents(result.contents, { guardTurns: true });
  return attachToolNameMap(result, toolNamer.toolNameMap);
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream) {
  return openaiToGeminiBase(model, body, stream);
}

// OpenAI -> Gemini CLI (Cloud Code Assist)
export function openaiToGeminiCLIRequest(model, body, stream) {
  const gemini = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE);
  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // Clean schema for tools
  if (gemini.tools?.[0]?.functionDeclarations) {
    for (const fn of gemini.tools[0].functionDeclarations) {
      if (fn.parameters) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(fn.parameters);
        fn.parameters = cleanedSchema;
        // if (isClaude) {
        //   fn.parameters = cleanedSchema;
        // } else {
        //   fn.parametersJsonSchema = cleanedSchema;
        //   delete fn.parameters;
        // }
      }
    }
  }

  return gemini;
}

// Wrap Gemini CLI format in Cloud Code wrapper
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: isAntigravity ? "antigravity" : "gemini-cli",
    requestId: isAntigravity ? `agent-${generateUUID()}` : generateRequestId(),
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || (isAntigravity ? deriveSessionId(credentials?.email || credentials?.connectionId) : generateSessionId()),
      contents: geminiCLI.contents,
      systemInstruction: geminiCLI.systemInstruction,
      generationConfig: geminiCLI.generationConfig,
      tools: geminiCLI.tools,
    }
  };

  // Antigravity leaves requestType off the agent path: the official client never
  // sends it, and Google buckets requestType:"agent" into a detail-free 429
  // RESOURCE_EXHAUSTED even with quota left. Gemini CLI keeps its safetySettings.
  if (!isAntigravity) {
    envelope.request.safetySettings = geminiCLI.safetySettings;
  }

  if (geminiCLI.tools?.length > 0) {
    envelope.request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" }
    };
  }

  return attachToolNameMap(envelope, geminiCLI._toolNameMap);
}

// Wrap Claude format in Cloud Code envelope for Antigravity
function wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials = null, signature = DEFAULT_THINKING_AG_SIGNATURE) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: "antigravity",
    requestId: `agent-${generateUUID()}`,
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || deriveSessionId(credentials?.email || credentials?.connectionId),
      contents: [],
      generationConfig: {
        temperature: claudeRequest.temperature || 1,
        maxOutputTokens: claudeRequest.max_tokens || 4096
      }
    }
  };

  const toolNamer = createGeminiToolNamer();
  for (const name of declaredToolNames(claudeRequest.tools)) toolNamer.name(name);

  // Build tool_use id -> name map so functionResponse can use the correct name
  const toolUseIdToName = {};
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE && block.id && block.name) {
            toolUseIdToName[block.id] = block.name;
          }
        }
      }
    }
  }

  // Convert Claude messages to Gemini contents
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const parts = [];

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TEXT) {
            parts.push({ text: block.text });
          } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            parts.push({
              thoughtSignature: signature,
              functionCall: {
                id: block.id,
                name: toolNamer.name(block.name),
                args: block.input || {}
              }
            });
          } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            let content = block.content;
            if (Array.isArray(content)) {
              content = content.map(c => c.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c)).join("\n");
            }
            // Resolve the original tool name from the id — Gemini requires it to match the functionCall name
            const resolvedName = toolUseIdToName[block.tool_use_id]
              ? toolNamer.name(toolUseIdToName[block.tool_use_id])
              : "tool";
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: resolvedName,
                response: { result: tryParseJSON(content) || content }
              }
            });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        envelope.request.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts
        });
      }
    }
  }

  // Convert Claude tools to Gemini functionDeclarations
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    const functionDeclarations = [];
    for (const tool of claudeRequest.tools) {
      if (tool.name && tool.input_schema) {
        functionDeclarations.push({
          name: toolNamer.name(tool.name),
          description: tool.description || "",
          parameters: toGeminiParameters(tool.input_schema)
        });
      }
    }
    if (functionDeclarations.length > 0) {
      envelope.request.tools = [{ functionDeclarations }];
      envelope.request.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" }
      };
    }
  }

  const systemParts = [];
  // Merge user system prompt from claudeRequest
  if (claudeRequest.system) {
    if (Array.isArray(claudeRequest.system)) {
      for (const block of claudeRequest.system) {
        if (block.text) systemParts.push({ text: block.text });
      }
    } else if (typeof claudeRequest.system === "string") {
      systemParts.push({ text: claudeRequest.system });
    }
  }

  if (systemParts.length > 0) {
    envelope.request.systemInstruction = { role: GEMINI_ROLE.USER, parts: systemParts };
  }

  // #4345：同上，antigravity/gemini 端点都拒绝以 model 轮收尾的请求。
  envelope.request.contents = normalizeGeminiContents(envelope.request.contents, { guardTurns: true });
  return attachToolNameMap(envelope, toolNamer.toolNameMap);
}

// Detect if model should use Claude backend in Antigravity
// Claude models have specific ID patterns — more reliable than caps at routing level
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  if (isClaudeModel(model)) {
    const claudeRequest = openaiToClaudeRequestForAntigravity(model, body, stream);
    return wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials);
  }

  const geminiCLI = openaiToGeminiCLIRequest(model, body, stream);
  return wrapInCloudCodeEnvelope(model, geminiCLI, credentials, true);
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, openaiToGeminiRequest, null);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, (model, body, stream, credentials) => wrapInCloudCodeEnvelope(model, openaiToGeminiCLIRequest(model, body, stream), credentials), null);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);
