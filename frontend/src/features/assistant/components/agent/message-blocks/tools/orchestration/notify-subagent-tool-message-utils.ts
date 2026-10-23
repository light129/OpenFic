import i18n from "@/i18n";
import type { AgentMessage } from "@/lib/agent.types";

import { getSubagentTargetLabel, isBackgroundSubagent } from "./subagent-tool-message-utils";

export function getNotifySubagentTitle(message?: AgentMessage): string {
  return i18n.t(
    message && isBackgroundSubagent(message)
      ? "assistant.subagentAction.notifyBackground"
      : "assistant.subagentAction.notify",
  );
}

export function getNotifySubagentDetail(message: AgentMessage): string {
  return getSubagentTargetLabel(message);
}
