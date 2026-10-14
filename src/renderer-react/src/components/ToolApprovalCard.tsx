import { useEffect, useState } from "react";
import { Box, Button, Checkbox, Chip, Paper, Stack, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import type { PendingToolApproval, ToolApprovalDecision } from "../hooks/useAgentRunChat";

/**
 * Shown when a GeoGebra batch contains 2D style commands the user did not ask
 * for. Construction and label commands run automatically; only the style
 * commands are offered here, each individually, with batch controls on top.
 */
export function ToolApprovalCard({ request, onResolve }: {
  request: PendingToolApproval;
  onResolve: (decision: ToolApprovalDecision) => void;
}) {
  const { t } = useTranslation();
  const [approved, setApproved] = useState<Set<string>>(() => new Set(request.reviewCommands));

  useEffect(() => {
    setApproved(new Set(request.reviewCommands));
  }, [request]);

  const toggle = (command: string) => setApproved((current) => {
    const next = new Set(current);
    if (next.has(command)) next.delete(command);
    else next.add(command);
    return next;
  });

  return (
    <Paper
      className="tool-approval-card"
      role="alertdialog"
      aria-label={t("toolApproval.title")}
      elevation={3}
      sx={{ m: 1, p: 1.5 }}
    >
      <Stack spacing={1}>
        <Typography variant="subtitle2">{t("toolApproval.title")}</Typography>
        <Typography variant="caption" color="text.secondary">{t("toolApproval.description")}</Typography>
        {request.autoCommands.length ? (
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">{t("toolApproval.autoLabel")}</Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              {request.autoCommands.map((command, index) => (
                <Chip key={`${command}-${index}`} size="small" variant="outlined" label={command} />
              ))}
            </Box>
          </Stack>
        ) : null}
        <Stack spacing={0.25}>
          <Typography variant="caption" color="text.secondary">{t("toolApproval.reviewLabel")}</Typography>
          {request.reviewCommands.map((command, index) => (
            <Box
              component="label"
              key={`${command}-${index}`}
              sx={{ display: "flex", alignItems: "center", gap: 1 }}
            >
              <Checkbox
                size="small"
                checked={approved.has(command)}
                onChange={() => toggle(command)}
                slotProps={{ input: { "aria-label": command } }}
              />
              <Typography component="code" variant="caption">{command}</Typography>
            </Box>
          ))}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
          <Button size="small" color="inherit" onClick={() => onResolve({ approvedReviewCommands: [] })}>
            {t("toolApproval.rejectAll")}
          </Button>
          <Button
            size="small"
            onClick={() => onResolve({
              approvedReviewCommands: request.reviewCommands.filter((command) => approved.has(command)),
            })}
          >
            {t("toolApproval.approveSelected")}
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => onResolve({ approvedReviewCommands: [...request.reviewCommands] })}
          >
            {t("toolApproval.approveAll")}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
