import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import {
  agentThinkingProviderOptions,
  agentRoutingPrompt,
  getAdvancedDrawingToolDefinitions,
  type AgentRunLedgerRecord,
  type AgentRunUsage,
  type FunctionCallToolName
} from "@geochat-ai/app";
import {
  activateAgentSkill,
  createAgentSkillBrief,
  extractAgentSkillConstraintBrief,
  filterBusinessReadyAgentSkills,
  listAvailableAgentSkills,
  type AgentSkillBrief,
  type AgentSkillSummary
} from "./skills";
import {
  listCurriculumCatalogs,
  loadCurriculumNode,
  searchCurriculum,
  type CurriculumNode
} from "./curriculum";

const SKILL_SELECTOR_TIMEOUT_MS = 30_000;
const MAX_CURRICULUM_NODES = 3;
const MAX_DOMAIN_SKILLS = 5;
const MAX_CRAFT_SKILLS = 3;
// Process/presentation skills live under these categories. The backend routes
// skills here by category rather than trusting the selector's placement, so the
// per-group caps hold even if the model misroutes.
const CRAFT_SKILL_CATEGORIES = new Set(["geogebra-workflow", "visual-post-processing"]);
const skillSelectionCache = new Map<string, Promise<AgentSkillSelectionPacket>>();
const skillSelectorOutputSchema = z.object({
  status: z.enum(["selected", "not_needed"]),
  curriculumNodes: z.array(z.object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })).max(MAX_CURRICULUM_NODES),
  domainSkills: z.array(z.object({
    name: z.string().min(1),
    reason: z.string().min(1),
  })).max(MAX_DOMAIN_SKILLS),
  craftSkills: z.array(z.object({
    name: z.string().min(1),
    reason: z.string().min(1),
  })).max(MAX_CRAFT_SKILLS),
  selectorReason: z.string().min(1),
});

export type AgentSkillRuntimePolicy = {
  enabled: boolean;
  autoActivate: boolean;
  allowedSkillNames: string[] | null;
  visualProfile?: string;
};

export type AgentSkillSelectionStatus = "disabled" | "not_needed" | "selected" | "failed";

export type AgentSkillSelectionItem = {
  name: string;
  category?: string;
  parent?: string;
  level?: number;
  recipes: string[];
  reason: string;
};

export type AgentCurriculumSelectionItem = {
  id: string;
  source: CurriculumNode["source"];
  stage: CurriculumNode["stage"];
  edition: CurriculumNode["edition"];
  book: string;
  chapter: string;
  section?: string;
  skillIds: string[];
  recipeIds: string[];
  visualProfiles: string[];
  reason: string;
};

export type AgentSkillSelectionPacket = {
  status: AgentSkillSelectionStatus;
  visualProfile?: string;
  curriculumNodes: AgentCurriculumSelectionItem[];
  /** Subject-matter mathematical skills (what the problem is about). */
  domainSkills: AgentSkillSelectionItem[];
  /** GeoGebra authoring, presentation, and interaction skills (how to build it). */
  craftSkills: AgentSkillSelectionItem[];
  enabledAdvancedTools: string[];
  selectorReason: string;
  injectedContext: string;
  error?: string;
  modelCallCount?: number;
  usage?: AgentRunUsage | null;
};

type SkillSelectorCandidateContext = {
  catalogs: ReturnType<typeof listCurriculumCatalogs>;
  curriculumNodes: AgentCurriculumSelectionItem[];
  skillBriefs: AgentSkillBrief[];
  allowedSkillNames: string[] | null;
  visualProfile?: string;
};

export async function selectAgentSkillsForRun(input: {
  run: AgentRunLedgerRecord;
  model: LanguageModel;
  temperature: number | undefined;
  timeout?: number;
  disabledToolNames?: readonly FunctionCallToolName[];
}): Promise<AgentSkillSelectionPacket> {
  const policy = skillRuntimePolicyFromPrompt(input.run.prompt);
  const cacheKey = `${input.run.runId}:${input.run.prompt}`;
  const cached = skillSelectionCache.get(cacheKey);
  if (cached) {
    const packet = await cached;
    return { ...packet, modelCallCount: 0, usage: null };
  }

  const selection = !policy.enabled || !policy.autoActivate || skillSelectionToolsDisabled(input.disabledToolNames)
    ? Promise.resolve({
      status: "disabled",
      visualProfile: policy.visualProfile,
      curriculumNodes: [],
      domainSkills: [],
      craftSkills: [],
      enabledAdvancedTools: [],
      selectorReason: !policy.enabled
        ? "Agent Skills are disabled for this run."
        : !policy.autoActivate
          ? "Automatic skill selection is disabled for this run."
          : "Skill selection tools are disabled for this run.",
      injectedContext: ""
    } satisfies AgentSkillSelectionPacket)
    : runSkillSelector({
        ...input,
        timeout: Math.min(input.timeout ?? 120_000, SKILL_SELECTOR_TIMEOUT_MS)
      }, policy);
  const loggedSelection = selection.then((packet) => {
    console.info("[INFO] Agent skill selection completed", JSON.stringify({
      runId: input.run.runId,
      conversationId: input.run.conversationId,
      status: packet.status,
      domainSkills: packet.domainSkills.map((skill) => skill.name),
      craftSkills: packet.craftSkills.map((skill) => skill.name),
      curriculumNodes: packet.curriculumNodes.map((node) => node.id),
      enabledAdvancedTools: packet.enabledAdvancedTools,
    }));
    return packet;
  });
  skillSelectionCache.set(cacheKey, loggedSelection);
  return loggedSelection;
}

async function runSkillSelector(input: {
  run: AgentRunLedgerRecord;
  model: LanguageModel;
  temperature: number | undefined;
  timeout: number;
}, policy: AgentSkillRuntimePolicy): Promise<AgentSkillSelectionPacket> {
  let candidateContext: SkillSelectorCandidateContext | undefined;
  try {
    candidateContext = await buildSkillSelectorCandidateContext(input.run, policy);
    if (!candidateContext.curriculumNodes.length && !candidateContext.skillBriefs.length) {
      return {
        status: "not_needed",
        visualProfile: policy.visualProfile,
        curriculumNodes: [],
        domainSkills: [],
        craftSkills: [],
        enabledAdvancedTools: [],
        selectorReason: "No curriculum node or skill candidate matched this run.",
        injectedContext: ""
      };
    }
    const result = await generateText({
      model: input.model,
      system: skillSelectorSystemPrompt(input.run.locale),
      messages: [
        {
          role: "user",
          content: skillSelectorUserPrompt({
            prompt: input.run.prompt,
            locale: input.run.locale,
            attachmentCount: input.run.attachmentCount,
            policy,
            candidateContext
          })
        }
      ],
      // Skill selection has no side effects, so transient provider/network
      // failures are safe to retry using the AI SDK's native backoff.
      maxRetries: 3,
      temperature: input.temperature,
      timeout: input.timeout,
      providerOptions: agentThinkingProviderOptions({
        provider: input.run.modelProvider,
        enabled: false,
        effort: "standard",
      }),
      output: Output.object({
        name: "geochat_skill_selection",
        description: "A compact selection of curriculum nodes, domain skills, and craft skills for the current run.",
        schema: skillSelectorOutputSchema,
      }),
    });
    const packet = normalizeSkillSelectionPacket(result.output, policy);
    return {
      ...await enrichSkillSelectionPacket(packet, policy, candidateContext, input.run.locale),
      modelCallCount: 1,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
    };
  } catch (error) {
    console.error("[ERROR] Caught exception at backend/src/agent/skill-selector.ts:238", error);
    if (candidateContext) {
      return {
        ...await enrichSkillSelectionPacket(
        deterministicSkillSelectionPacket(candidateContext, policy, error),
        policy,
        candidateContext,
        input.run.locale
        ),
        modelCallCount: 1,
      };
    }
    return {
      status: "failed",
      visualProfile: policy.visualProfile,
      curriculumNodes: [],
      domainSkills: [],
      craftSkills: [],
      enabledAdvancedTools: [],
      selectorReason: "Temporary skill selector failed; continue without a preloaded skill packet.",
      injectedContext: "",
      error: error instanceof Error ? error.message : String(error),
      modelCallCount: candidateContext ? 1 : 0,
    };
  }
}

async function buildSkillSelectorCandidateContext(
  run: Pick<AgentRunLedgerRecord, "prompt">,
  policy: AgentSkillRuntimePolicy
): Promise<SkillSelectorCandidateContext> {
  const routingPrompt = agentRoutingPrompt(run.prompt);
  const catalogs = listCurriculumCatalogs();
  const curriculumMatches = searchCurriculum({ query: routingPrompt, limit: 5 });
  const curriculumNodes = curriculumMatches.slice(0, MAX_CURRICULUM_NODES).map((match): AgentCurriculumSelectionItem => ({
    id: match.id,
    source: match.source,
    stage: match.stage,
    edition: match.edition,
    book: match.book,
    chapter: match.chapter,
    ...(match.section ? { section: match.section } : {}),
    skillIds: match.skillIds,
    recipeIds: match.recipeIds,
    visualProfiles: match.visualProfiles,
    reason: `Matched ${match.matchedFields.slice(0, 4).join(", ") || "curriculum index"} with score ${match.score}.`
  }));
  const allowed = policy.allowedSkillNames?.length ? new Set(policy.allowedSkillNames.map((name) => name.toLowerCase())) : null;
  // The full allowed catalog is handed to the selector LLM. A keyword/text
  // pre-filter was proven to drop the right skill (e.g. locus problems never
  // surfaced `locus-envelope`), so selection is left to semantic reasoning.
  const availableSkills = filterBusinessReadyAgentSkills(await listAvailableAgentSkills())
    .filter((skill) => !allowed || allowed.has(skill.name.toLowerCase()));
  // Curriculum-referenced skills first, then alphabetical; ordering is a hint,
  // every candidate is still present.
  const referenced = new Set(curriculumNodes.flatMap((node) => node.skillIds));
  const orderedSkills = [...availableSkills].sort((left, right) =>
    Number(referenced.has(right.name)) - Number(referenced.has(left.name)) || left.name.localeCompare(right.name)
  );
  // Briefs are lightweight: no per-candidate SKILL.md read. Constraints are
  // extracted after selection, only for the chosen skills.
  const skillBriefs = orderedSkills.map((skill) => {
    const relatedNodes = curriculumNodes.filter((node) => node.skillIds.includes(skill.name));
    const visualProfiles = [
      ...(policy.visualProfile ? [policy.visualProfile] : []),
      ...relatedNodes.flatMap((node) => node.visualProfiles)
    ];
    return createAgentSkillBrief(skill, {
      curriculumIds: relatedNodes.map((node) => node.id),
      visualProfiles
    });
  });
  return {
    catalogs,
    curriculumNodes,
    skillBriefs,
    allowedSkillNames: policy.allowedSkillNames,
    ...(policy.visualProfile ? { visualProfile: policy.visualProfile } : {})
  };
}

export function skillRuntimePolicyFromPrompt(prompt: string): AgentSkillRuntimePolicy {
  const disabled = /Agent Skills are disabled for this run|本轮已关闭 Agent Skills/.test(prompt);
  if (disabled) return { enabled: false, autoActivate: false, allowedSkillNames: [], visualProfile: parseLastPolicyValue(prompt, [/Visual profile:\s*([^.\n]+)/g, /可视化表达策略：([^。\n]+)/g]) };
  const autoActivateValue = parseLastPolicyValue(prompt, [/Automatic loading:\s*([^.\n]+)/g, /自动加载：([^。\n]+)/g]);
  const allowedSkillsValue = parseLastPolicyValue(prompt, [/Allowed skills:\s*([^.\n]+)/g, /允许使用的技能：([^。\n]+)/g]);
  return {
    enabled: true,
    autoActivate: !/disabled|关闭/i.test(autoActivateValue ?? "enabled"),
    allowedSkillNames: allowedSkillsValue ? parseAllowedSkillNames(allowedSkillsValue) : null,
    visualProfile: parseLastPolicyValue(prompt, [/Visual profile:\s*([^.\n]+)/g, /可视化表达策略：([^。\n]+)/g])
  };
}

function parseLastPolicyValue(prompt: string, patterns: RegExp[]) {
  let value: string | undefined;
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) value = candidate;
    }
  }
  return value;
}

function parseAllowedSkillNames(value: string) {
  return value
    .split(/[,，、]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function skillSelectionToolsDisabled(disabledToolNames: readonly FunctionCallToolName[] | undefined) {
  const disabled = new Set(disabledToolNames ?? []);
  return ["listSkills", "searchSkills", "loadSkill"].some((toolName) => disabled.has(toolName as FunctionCallToolName));
}

function isCraftSkillCategory(category?: string) {
  return Boolean(category && CRAFT_SKILL_CATEGORIES.has(category));
}

export function skillSelectorSystemPrompt(locale?: AgentRunLedgerRecord["locale"]) {
  if (isEnglishLocale(locale)) {
    return [
      "You are GeoChat's temporary SkillSelector.",
      "Your job is to choose from the Candidate Skill Context before the main agent solves the problem.",
      "The Candidate Skill Context lists the full available skill catalog (name, description, category, recipes, tags). The backend loads the selected SKILL.md files and builds compressed guidance after your choice; do not ask for tools and do not invent skills outside the catalog.",
      "Split your choice into two groups. domainSkills are subject-matter mathematical skills (what the problem is about). craftSkills are GeoGebra authoring, presentation, and interaction skills (how to build, present, and operate the figure).",
      "Choose skills as a complementary set: prefer one broad parent skill plus one or two precise second-layer skills/recipes. If the broad parent adds no useful rule beyond the precise skill, select only the precise skill.",
      "The main agent must not receive the full catalog. The backend will load selected SKILL.md files and build the compressed guidance after your choice.",
      "Do not solve the problem. Do not plan concrete GeoGebra command batches. Do not include chain-of-thought.",
      "Fill the requested structured output fields with a compact selection.",
      `Select at most ${MAX_CURRICULUM_NODES} curriculum nodes, at most ${MAX_DOMAIN_SKILLS} domain skills, and at most ${MAX_CRAFT_SKILLS} craft skills. If no skill is useful after reviewing the catalog, use status not_needed and explain why no skill is needed.`
    ].join("\n");
  }
  return [
    "你是 GeoChat 的临时 SkillSelector。",
    "你的任务是在主 agent 解题前，从压缩 Candidate Skill Context 中选择技能。",
    "Candidate Skill Context 列出全部可用技能目录（名称、描述、category、recipes、tags）。后端会在你选择后读取所选 SKILL.md 并生成压缩指导；不要请求工具，也不要选择目录之外的技能。",
    "把选择分成两组：domainSkills 是学科数学技能（题目考什么）；craftSkills 是 GeoGebra 作图书面、呈现与交互技能（怎么画、怎么展示、怎么操作）。",
    "技能选择要按互补关系装配：优先选择一个宽领域父技能加一到两个精确二级技能/recipe；如果父技能没有额外规则，只选择精确技能。",
    "主 agent 不应收到完整技能目录；后端会在你选择后读取对应 SKILL.md 并生成压缩指导。",
    "不要解题，不要规划具体 GeoGebra 命令批次，不要输出思维链。",
    "按请求的结构化输出字段返回精简的选择结果。",
    `最多选择 ${MAX_CURRICULUM_NODES} 个教材节点、${MAX_DOMAIN_SKILLS} 个 domainSkills 和 ${MAX_CRAFT_SKILLS} 个 craftSkills；审阅目录后仍无明显帮助时返回 status=not_needed，并说明为什么不需要技能。`
  ].join("\n");
}

function skillSelectorUserPrompt(input: {
  prompt: string;
  locale?: AgentRunLedgerRecord["locale"];
  attachmentCount: number;
  policy: AgentSkillRuntimePolicy;
  candidateContext: SkillSelectorCandidateContext;
}) {
  const allowedSkills = input.policy.allowedSkillNames?.length ? input.policy.allowedSkillNames.join(", ") : "all available skills";
  const contextJson = JSON.stringify(input.candidateContext, null, 2);
  if (isEnglishLocale(input.locale)) {
    return [
      `Locale: ${input.locale ?? "unknown"}`,
      `Attachment count: ${input.attachmentCount}`,
      `Allowed skills: ${allowedSkills}`,
      `Visual profile: ${input.policy.visualProfile ?? "unspecified"}`,
      "",
      "Candidate Skill Context:",
      contextJson,
      "",
      "Problem:",
      agentRoutingPrompt(input.prompt)
    ].join("\n");
  }
  return [
    `语言：${input.locale ?? "unknown"}`,
    `附件数量：${input.attachmentCount}`,
    `允许技能：${allowedSkills}`,
    `可视化表达策略：${input.policy.visualProfile ?? "未指定"}`,
    "",
    "Candidate Skill Context：",
    contextJson,
    "",
    "题目：",
    agentRoutingPrompt(input.prompt)
  ].join("\n");
}

function normalizeSkillSelectionPacket(value: unknown, policy: AgentSkillRuntimePolicy): AgentSkillSelectionPacket {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const curriculumNodes = Array.isArray(record.curriculumNodes)
    ? record.curriculumNodes
        .map(normalizeSelectedCurriculumNode)
        .filter((item): item is AgentCurriculumSelectionItem => Boolean(item))
        .slice(0, MAX_CURRICULUM_NODES)
    : [];
  const domainSkills = Array.isArray(record.domainSkills)
    ? record.domainSkills
        .map(normalizeSelectedSkill)
        .filter((skill): skill is AgentSkillSelectionItem => Boolean(skill))
        .slice(0, MAX_DOMAIN_SKILLS)
    : [];
  const craftSkills = Array.isArray(record.craftSkills)
    ? record.craftSkills
        .map(normalizeSelectedSkill)
        .filter((skill): skill is AgentSkillSelectionItem => Boolean(skill))
        .slice(0, MAX_CRAFT_SKILLS)
    : [];
  const status = domainSkills.length || craftSkills.length || curriculumNodes.length ? "selected" : "not_needed";
  return {
    status,
    visualProfile: policy.visualProfile,
    curriculumNodes,
    domainSkills,
    craftSkills,
    enabledAdvancedTools: [],
    selectorReason: stringValue(record.selectorReason) ?? (status === "selected" ? "A matching skill was selected." : "No skill was clearly needed."),
    injectedContext: stringValue(record.injectedContext) ?? "",
  };
}

function deterministicSkillSelectionPacket(
  context: SkillSelectorCandidateContext,
  policy: AgentSkillRuntimePolicy,
  error?: unknown
): AgentSkillSelectionPacket {
  const domainSkills: AgentSkillSelectionItem[] = [];
  const craftSkills: AgentSkillSelectionItem[] = [];
  // Only skills linked to a matched curriculum node are safe to inject when the
  // selector LLM fails; the full catalog has no relevance signal of its own.
  for (const skill of context.skillBriefs.filter((brief) => brief.curriculumIds.length)) {
    const item: AgentSkillSelectionItem = {
      name: skill.name,
      ...(skill.category ? { category: skill.category } : {}),
      ...(skill.parent ? { parent: skill.parent } : {}),
      ...(skill.level ? { level: skill.level } : {}),
      recipes: skill.recipeIds,
      reason: "Selected by deterministic fallback from the prebuilt skill candidate context."
    };
    if (isCraftSkillCategory(skill.category)) {
      if (craftSkills.length < MAX_CRAFT_SKILLS) craftSkills.push(item);
    } else if (domainSkills.length < MAX_DOMAIN_SKILLS) {
      domainSkills.push(item);
    }
  }
  const status = domainSkills.length || craftSkills.length || context.curriculumNodes.length ? "selected" : "failed";
  return {
    status,
    visualProfile: policy.visualProfile,
    curriculumNodes: context.curriculumNodes.slice(0, MAX_CURRICULUM_NODES),
    domainSkills,
    craftSkills,
    enabledAdvancedTools: [],
    selectorReason: status === "selected"
      ? "Temporary skill selector failed; deterministic candidate context was used."
      : "Temporary skill selector failed and no candidate context was available.",
    injectedContext: "",
    error: error instanceof Error ? error.message : error ? String(error) : undefined
  };
}

async function enrichSkillSelectionPacket(
  packet: AgentSkillSelectionPacket,
  policy: AgentSkillRuntimePolicy,
  candidateContext?: SkillSelectorCandidateContext,
  locale?: AgentRunLedgerRecord["locale"]
): Promise<AgentSkillSelectionPacket> {
  if (!packet.domainSkills.length && !packet.craftSkills.length && !packet.curriculumNodes.length) return packet;
  const allowed = policy.allowedSkillNames?.length ? new Set(policy.allowedSkillNames.map((name) => name.toLowerCase())) : null;
  const summaries = new Map((await listAvailableAgentSkills()).map((skill) => [skill.name.toLowerCase(), skill]));
  const curriculumNodes = packet.curriculumNodes
    .map((selected): AgentCurriculumSelectionItem | undefined => {
      try {
        const item = loadCurriculumNode(selected.id);
        return {
          id: item.id,
          source: item.source,
          stage: item.stage,
          edition: item.edition,
          book: item.book,
          chapter: item.chapter,
          ...(item.section ? { section: item.section } : {}),
          skillIds: item.skillIds,
          recipeIds: item.recipeIds,
          visualProfiles: item.visualProfiles,
          reason: selected.reason
        };
      } catch (caughtError) {
        console.error("[ERROR] Caught exception at backend/src/agent/skill-selector.ts:463", caughtError);
        return undefined;
      }
    })
    .filter((item): item is AgentCurriculumSelectionItem => Boolean(item));
  const requestedSkills = packet.domainSkills.length || packet.craftSkills.length
    ? [...packet.domainSkills, ...packet.craftSkills]
    : candidateSkillSelectionsFromCurriculum(curriculumNodes, summaries, allowed);
  const { domainSkills, craftSkills } = routeSelectedSkills(requestedSkills, summaries, allowed);
  const selectedSkills = [...domainSkills, ...craftSkills];
  const activatedSkills = await Promise.all(
    selectedSkills.map(async (skill) => {
      try {
        return await activateAgentSkill(skill.name);
      } catch (caughtError) {
        console.error("[ERROR] Caught exception at backend/src/agent/skill-selector.ts:492", caughtError);
        return undefined;
      }
    })
  );
  const enabledAdvancedTools = enabledAdvancedToolsFromActivatedSkills(
    activatedSkills.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
  );
  if (!selectedSkills.length) {
    if (curriculumNodes.length) {
      return {
        ...packet,
        status: "selected",
        curriculumNodes,
        domainSkills: [],
        craftSkills: [],
        enabledAdvancedTools: [],
        injectedContext: buildSkillSelectionInjectedContext({
          locale,
          curriculumNodes,
          selectedSkills: [],
          activatedSkills: [],
          visualProfile: policy.visualProfile,
          selectorContext: packet.injectedContext
        })
      };
    }
    return {
      ...packet,
      status: "not_needed",
      curriculumNodes,
      domainSkills: [],
      craftSkills: [],
      enabledAdvancedTools: [],
      selectorReason: "The selector did not return a valid allowed skill.",
      injectedContext: ""
    };
  }
  return {
    ...packet,
    status: "selected",
    curriculumNodes,
    domainSkills,
    craftSkills,
    enabledAdvancedTools,
    injectedContext: buildSkillSelectionInjectedContext({
      locale,
      curriculumNodes,
      selectedSkills,
      activatedSkills: activatedSkills.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill)),
      visualProfile: policy.visualProfile,
      selectorContext: packet.injectedContext
    })
  };
}

/**
 * Resolve requested skill names against the catalog, re-route each skill to its
 * category's group (domain vs craft), dedupe, and enforce the per-group caps.
 * The selector's own grouping is treated as a hint; this keeps the caps true.
 */
function routeSelectedSkills(
  requestedSkills: readonly AgentSkillSelectionItem[],
  summaries: ReadonlyMap<string, AgentSkillSummary>,
  allowed: Set<string> | null
) {
  const domainSkills: AgentSkillSelectionItem[] = [];
  const craftSkills: AgentSkillSelectionItem[] = [];
  const seen = new Set<string>();
  for (const selected of requestedSkills) {
    const summary = summaries.get(selected.name.toLowerCase());
    if (!summary || (allowed && !allowed.has(summary.name.toLowerCase()))) continue;
    const key = summary.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const item: AgentSkillSelectionItem = {
      name: summary.name,
      ...(summary.category ? { category: summary.category } : {}),
      ...(summary.parent ? { parent: summary.parent } : {}),
      ...(summary.level ? { level: summary.level } : {}),
      recipes: summary.recipes,
      reason: selected.reason
    };
    if (isCraftSkillCategory(summary.category)) {
      if (craftSkills.length < MAX_CRAFT_SKILLS) craftSkills.push(item);
    } else if (domainSkills.length < MAX_DOMAIN_SKILLS) {
      domainSkills.push(item);
    }
  }
  return { domainSkills, craftSkills };
}

function candidateSkillSelectionsFromCurriculum(
  curriculumNodes: readonly AgentCurriculumSelectionItem[],
  summaries: ReadonlyMap<string, AgentSkillSummary>,
  allowed: Set<string> | null
) {
  const candidateNames = curriculumNodes.flatMap((node) => node.skillIds);
  const selections: AgentSkillSelectionItem[] = [];
  for (const name of candidateNames) {
    const summary = summaries.get(name.toLowerCase());
    if (!summary || (allowed && !allowed.has(summary.name.toLowerCase()))) continue;
    if (selections.some((selection) => selection.name.toLowerCase() === summary.name.toLowerCase())) continue;
    selections.push({
      name: summary.name,
      ...(summary.category ? { category: summary.category } : {}),
      ...(summary.parent ? { parent: summary.parent } : {}),
      ...(summary.level ? { level: summary.level } : {}),
      recipes: summary.recipes,
      reason: "Selected from matched curriculum node skillIds."
    });
    if (selections.length >= MAX_DOMAIN_SKILLS + MAX_CRAFT_SKILLS) break;
  }
  return selections;
}

function enabledAdvancedToolsFromActivatedSkills(skills: readonly { advancedTools: readonly string[] }[]) {
  const registered = new Set<string>(getAdvancedDrawingToolDefinitions().map((definition) => definition.name));
  return [...new Set(skills.flatMap((skill) => skill.advancedTools))]
    .filter((name) => registered.has(name))
    .sort();
}

function buildSkillSelectionInjectedContext(input: {
  locale?: AgentRunLedgerRecord["locale"];
  curriculumNodes: readonly AgentCurriculumSelectionItem[];
  selectedSkills: readonly AgentSkillSelectionItem[];
  activatedSkills: readonly { name: string; markdown: string }[];
  visualProfile?: string;
  selectorContext?: string;
}) {
  const visualProfiles = Array.from(new Set([
    ...(input.visualProfile ? [input.visualProfile] : []),
    ...input.curriculumNodes.flatMap((node) => node.visualProfiles)
  ]));
  const constraints = input.activatedSkills.flatMap((skill) =>
    extractAgentSkillConstraintBrief(skill.markdown, 4).map((line) => `${skill.name}: ${line}`)
  ).slice(0, 10);
  const recipeLines = input.selectedSkills
    .filter((skill) => skill.recipes.length)
    .map((skill) => `${skill.name}: ${skill.recipes.slice(0, 4).join(", ")}`);
  if (isEnglishLocale(input.locale)) {
    return [
      input.curriculumNodes.length
        ? `Curriculum localization: ${input.curriculumNodes.map((node) => `${node.edition} ${node.book} / ${node.chapter}${node.section ? ` / ${node.section}` : ""}`).join("; ")}.`
        : "",
      recipeLines.length ? `Recipe hints: ${recipeLines.join("; ")}.` : "",
      visualProfiles.length ? `Visual profile hints: ${visualProfiles.join(", ")}.` : "",
      constraints.length ? `Skill constraints: ${constraints.join(" | ")}` : "",
      input.selectorContext ? `Selector note: ${input.selectorContext}` : ""
    ].filter(Boolean).join("\n");
  }
  return [
    input.curriculumNodes.length
      ? `教材定位：${input.curriculumNodes.map((node) => `${node.edition}${node.book} / ${node.chapter}${node.section ? ` / ${node.section}` : ""}`).join("；")}。`
      : "",
    recipeLines.length ? `题型策略：${recipeLines.join("；")}。` : "",
    visualProfiles.length ? `可视化策略：${visualProfiles.join("、")}。` : "",
    constraints.length ? `技能约束：${constraints.join(" | ")}` : "",
    input.selectorContext ? `选择器补充：${input.selectorContext}` : ""
  ].filter(Boolean).join("\n");
}

function normalizeSelectedCurriculumNode(value: unknown): AgentCurriculumSelectionItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  if (!id) return undefined;
  return {
    id,
    source: "pep",
    stage: "senior",
    edition: "人教A版",
    book: "",
    chapter: "",
    skillIds: [],
    recipeIds: [],
    visualProfiles: [],
    reason: stringValue(record.reason) ?? "Matched by the temporary skill selector."
  };
}

function normalizeSelectedSkill(value: unknown): AgentSkillSelectionItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = stringValue(record.name);
  if (!name) return undefined;
  return {
    name,
    ...(stringValue(record.category) ? { category: stringValue(record.category) } : {}),
    ...(stringValue(record.parent) ? { parent: stringValue(record.parent) } : {}),
    ...(typeof record.level === "number" && Number.isFinite(record.level) ? { level: Math.floor(record.level) } : {}),
    recipes: Array.isArray(record.recipes) ? record.recipes.filter((recipe): recipe is string => typeof recipe === "string") : [],
    reason: stringValue(record.reason) ?? "Selected by the temporary skill selector."
  };
}

export function formatSkillSelectionPacketPrompt(packet: AgentSkillSelectionPacket, locale?: AgentRunLedgerRecord["locale"]) {
  if (isEnglishLocale(locale)) {
    return [
      "[Preselected Agent Skill packet]",
      `Status: ${packet.status}.`,
      `Visual profile: ${packet.visualProfile ?? "unspecified"}.`,
      ...formatSelectedSkillLines(packet.domainSkills, "Domain skills (mathematics)", "en-US"),
      ...formatSelectedSkillLines(packet.craftSkills, "Craft skills (GeoGebra authoring/presentation)", "en-US"),
      packet.curriculumNodes.length
        ? [
            "Curriculum localization:",
            ...packet.curriculumNodes.map((item) =>
              `- ${item.edition} ${item.book} / ${item.chapter}${item.section ? ` / ${item.section}` : ""}: ${item.reason}`
            )
          ].join("\n")
        : "Curriculum localization: none.",
      packet.enabledAdvancedTools.length
        ? [
            "Unlocked advanced drawing commands:",
            ...packet.enabledAdvancedTools.map((name) => {
              const definition = getAdvancedDrawingToolDefinitions([name])[0];
              return formatAdvancedDrawingDefinitionForPacket(name, definition, "en-US");
            })
          ].join("\n")
        : "Unlocked advanced drawing commands: none.",
      packet.injectedContext ? `Compressed guidance: ${packet.injectedContext}` : "",
      `Selector reason: ${packet.selectorReason}`,
      packet.error ? `Selector error: ${packet.error}` : "",
      "Use this packet as guidance only. It is not a mathematical fact source. Do not call listSkills, searchSkills, loadSkill, or activateSkill again unless this packet is missing, failed, or clearly insufficient."
    ].filter(Boolean).join("\n");
  }
  return [
    "【预选 Agent Skill Packet】",
    `状态：${packet.status}。`,
    `可视化表达策略：${packet.visualProfile ?? "未指定"}。`,
    ...formatSelectedSkillLines(packet.domainSkills, "学科数学技能（domainSkills）", "zh-CN"),
    ...formatSelectedSkillLines(packet.craftSkills, "作图书面与交互技能（craftSkills）", "zh-CN"),
    packet.curriculumNodes.length
      ? [
          "教材定位：",
          ...packet.curriculumNodes.map((item) =>
            `- ${item.edition}${item.book} / ${item.chapter}${item.section ? ` / ${item.section}` : ""}：${item.reason}`
          )
        ].join("\n")
      : "教材定位：无。",
    packet.enabledAdvancedTools.length
        ? [
            "已解锁高级绘图命令：",
            ...packet.enabledAdvancedTools.map((name) => {
              const definition = getAdvancedDrawingToolDefinitions([name])[0];
              return formatAdvancedDrawingDefinitionForPacket(name, definition, "zh-CN");
            })
          ].join("\n")
        : "已解锁高级绘图命令：无。",
    packet.injectedContext ? `压缩指导：${packet.injectedContext}` : "",
    `选择理由：${packet.selectorReason}`,
    packet.error ? `选择器错误：${packet.error}` : "",
    "该 packet 只作为策略提示，不是数学事实来源。除非 packet 缺失、失败或明显不足，否则主 agent 不要再次调用 listSkills、searchSkills、loadSkill 或 activateSkill。"
  ].filter(Boolean).join("\n");
}

function formatSelectedSkillLines(
  skills: readonly AgentSkillSelectionItem[],
  heading: string,
  locale: "zh-CN" | "en-US"
) {
  if (!skills.length) return [`${heading}: none.`];
  return [
    `${heading}:`,
    ...skills.map((skill) =>
      skill.recipes.length
        ? locale === "en-US"
          ? `- ${skill.name} (recipes: ${skill.recipes.join(", ")}): ${skill.reason}`
          : `- ${skill.name}（recipes：${skill.recipes.join("、")}）：${skill.reason}`
        : `- ${skill.name}: ${skill.reason}`
    )
  ];
}

function formatAdvancedDrawingDefinitionForPacket(
  name: string,
  definition: ReturnType<typeof getAdvancedDrawingToolDefinitions>[number] | undefined,
  locale: "zh-CN" | "en-US"
) {
  if (!definition) return locale === "en-US" ? `- ${name}: High-level drawing command.` : `- ${name}：高级绘图命令。`;
  const parameters = definition.parameters
    .map((parameter) => `${parameter.name}:${parameter.kind}${"required" in parameter && parameter.required ? "*" : ""}`)
    .join(", ");
  if (locale === "en-US") {
    return [
      `- ${name}: ${definition.description}`,
      `  Parameters: ${parameters || "none"}.`,
      `  Assumptions: ${definition.assumptions.join("; ")}`,
      `  Invariants: ${definition.invariants.join("; ")}`
    ].join("\n");
  }
  return [
    `- ${name}：${definition.description}`,
    `  参数：${parameters || "无"}。`,
    `  前提：${definition.assumptions.join("；")}`,
    `  不变量：${definition.invariants.join("；")}`
  ].join("\n");
}

function isEnglishLocale(locale: AgentRunLedgerRecord["locale"] | undefined) {
  return locale === "en-US";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
