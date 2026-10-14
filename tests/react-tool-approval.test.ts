import { describe, expect, test } from "bun:test";
import { commandsWithApprovedReview, planCommandApproval } from "../src/renderer-react/src/features/agent-run/toolApproval";
import { styleApprovalRequiredForRun } from "../backend/src/agent/ai-sdk-tools";
import type { AgentSkillSelectionPacket } from "../backend/src/agent/skill-selector";

const emptyPacket: AgentSkillSelectionPacket = {
  status: "not_needed",
  curriculumNodes: [],
  domainSkills: [],
  craftSkills: [],
  enabledAdvancedTools: [],
  selectorReason: "none",
  injectedContext: "",
};

describe("GeoGebra style approval", () => {
  test("separates style commands from construction and label commands", () => {
    const plan = planCommandApproval([
      "O = (0, 0)",
      "c = Circle(O, 3)",
      "SetLineThickness(c, 3)",
      "SetLabelMode(O, 3)",
      "SetColor(c, 0.1, 0.2, 0.3)",
    ]);
    expect(plan.autoCommands).toEqual(["O = (0, 0)", "c = Circle(O, 3)", "SetLabelMode(O, 3)"]);
    expect(plan.reviewCommands).toEqual(["SetLineThickness(c, 3)", "SetColor(c, 0.1, 0.2, 0.3)"]);
  });

  test("keeps only approved style commands in the executed batch, preserving order", () => {
    const commands = ["O = (0, 0)", "SetLineThickness(c, 3)", "SetPointSize(c, 3)"];
    const plan = planCommandApproval(commands);
    expect(commandsWithApprovedReview(commands, plan.reviewCommands, ["SetPointSize(c, 3)"])).toEqual([
      "O = (0, 0)",
      "SetPointSize(c, 3)",
    ]);
    expect(commandsWithApprovedReview(commands, plan.reviewCommands, [])).toEqual(["O = (0, 0)"]);
  });

  test("does not require approval when the user asked for styling", () => {
    expect(styleApprovalRequiredForRun("把圆改成红色，线加粗")).toBe(false);
  });

  test("does not require approval when a styling craft skill was selected", () => {
    expect(styleApprovalRequiredForRun("画一个圆", {
      ...emptyPacket,
      status: "selected",
      craftSkills: [{ name: "visual-style-system", recipes: [], reason: "styling" }],
    })).toBe(false);
  });

  test("requires approval when the model styles without being asked", () => {
    expect(styleApprovalRequiredForRun("画一个圆", {
      ...emptyPacket,
      status: "selected",
      domainSkills: [{ name: "plane-geometry", recipes: [], reason: "geometry" }],
    })).toBe(true);
    expect(styleApprovalRequiredForRun("画一个圆")).toBe(true);
  });
});
