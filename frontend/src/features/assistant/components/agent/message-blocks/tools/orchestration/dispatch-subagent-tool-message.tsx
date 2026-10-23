import i18n from "@/i18n";
import type { AgentMessage } from "@/lib/agent.types";

import { getSubagentTargetLabel, isBackgroundSubagent } from "./subagent-tool-message-utils";

export function getSubagentDispatchTitle(message: AgentMessage): string {
  return i18n.t(
    isBackgroundSubagent(message)
      ? "assistant.subagentAction.dispatchBackground"
      : "assistant.subagentAction.dispatch",
  );
}

export function getSubagentDispatchDetail(message: AgentMessage): string {
  return getSubagentTargetLabel(message);
}
