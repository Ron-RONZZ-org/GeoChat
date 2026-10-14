import {
  findForbiddenFixedAxisObjectCommands,
  findGeoGebraCommandBatchPolicyViolations,
  findUnsupportedGeoGebraCommands,
  fixedAxisObjectPolicyMessage,
  geogebraCommandBatchPolicyMessage,
  isFunctionCallArgs,
  unsupportedGeoGebraCommandPolicyMessage,
  type FunctionCallArgsByName,
  type FunctionCallToolName,
} from "@geochat-ai/app";

export type NativeToolPolicyContext = {
  prompt: string;
  locale?: "zh-CN" | "en-US" | null;
};

export function validateNativeToolInput<TToolName extends FunctionCallToolName>(
  toolName: TToolName,
  value: unknown,
  context: NativeToolPolicyContext,
): { success: true; value: FunctionCallArgsByName[TToolName] } | { success: false; error: Error } {
  if (!isFunctionCallArgs(toolName, value)) {
    return {
      success: false,
      error: new TypeError(`Invalid input for GeoChat tool ${toolName}.`),
    };
  }
  if (toolName !== "executeGeoGebraCommands") {
    return { success: true, value };
  }

  // Reject-with-feedback: unsupported commands, fixed-axis reassignment, and
  // oversized/malformed batches fail validation so the AI SDK's repair path
  // hands the reason back to the model. Nothing here silently rewrites or drops
  // model output.
  const unsupportedViolations = findUnsupportedGeoGebraCommands(value);
  if (unsupportedViolations.length) {
    return {
      success: false,
      error: new TypeError(unsupportedGeoGebraCommandPolicyMessage(unsupportedViolations, context.locale)),
    };
  }
  const fixedAxisViolations = findForbiddenFixedAxisObjectCommands(value);
  if (fixedAxisViolations.length) {
    return {
      success: false,
      error: new TypeError(fixedAxisObjectPolicyMessage(fixedAxisViolations, context.locale)),
    };
  }
  const batchViolations = findGeoGebraCommandBatchPolicyViolations(value);
  if (batchViolations.length) {
    return {
      success: false,
      error: new TypeError(geogebraCommandBatchPolicyMessage(batchViolations, context.locale)),
    };
  }
  return { success: true, value };
}
