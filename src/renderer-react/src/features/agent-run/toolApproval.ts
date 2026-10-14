import { findTwoDimensionalStyleCommands } from "@geochat-ai/app/geogebra-style-policy";

export type CommandApprovalPlan = {
  /** Commands that run without asking (construction, labels, ...). */
  autoCommands: string[];
  /** Commands that need the user's approval first (2D style edits). */
  reviewCommands: string[];
};

/**
 * Split a GeoGebra command batch into commands that execute automatically and
 * commands that require the user's approval. Style classification is shared with
 * the backend policy so both sides agree on what counts as a 2D style edit.
 */
export function planCommandApproval(commands: readonly string[]): CommandApprovalPlan {
  const violations = findTwoDimensionalStyleCommands({ commands });
  const review = new Set(violations.map((violation) => violation.command));
  return {
    autoCommands: commands.filter((command) => !review.has(command)),
    reviewCommands: commands.filter((command) => review.has(command)),
  };
}

/**
 * Keep every non-review command, plus only the review commands the user
 * approved, preserving the original batch order.
 */
export function commandsWithApprovedReview(
  commands: readonly string[],
  reviewCommands: readonly string[],
  approvedReviewCommands: readonly string[],
): string[] {
  const review = new Set(reviewCommands);
  const approved = new Set(approvedReviewCommands);
  return commands.filter((command) => !review.has(command) || approved.has(command));
}
