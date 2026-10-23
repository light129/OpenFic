import { Badge, Box, Button, Dialog, Flex, IconButton, Text } from "@radix-ui/themes";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { apiClient } from "@/lib/api-client";
import { getSocket } from "@/lib/socket-client";

import "./agent-board.css";

interface BoardMessage {
  id: string;
  seq: number;
  from: string;
  to: string;
  type: "INFO" | "ASK" | "RESULT" | "HOLD" | "VETO";
  body: string;
  reply_to: string | null;
  retracted: boolean;
  created_at: string;
}

interface BoardView {
  root_session_id: string;
  messages: BoardMessage[];
  participants: { id: string; label: string; state: string; active: boolean }[];
  participants_truncated: boolean;
  has_more: boolean;
  next_before: number | null;
}

export function AgentBoardDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["agent-board", sessionId];
  const {
    data,
    isPending,
    isError,
    isFetching,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey,
    enabled: open && Boolean(sessionId),
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) =>
      (
        await apiClient.get<BoardView>(`/agent/sessions/${encodeURIComponent(sessionId)}/board`, {
          params: { before: pageParam, limit: 50 },
          signal,
        })
      ).data,
    getNextPageParam: (page) => (page.has_more ? page.next_before : undefined),
    staleTime: 0,
  });

  useEffect(() => {
    if (!open || !sessionId) return;
    const socket = getSocket();
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-board", sessionId] });
    };
    const onPost = (event: { session_id?: string }) => {
      if (event.session_id === sessionId) refresh();
    };
    const onStatus = (event: { parent_session_id?: string }) => {
      if (event.parent_session_id === sessionId) refresh();
    };
    socket.on("agent:board", onPost);
    socket.on("agent:subagent_status", onStatus);
    socket.on("agent:done", onPost);
    socket.on("agent:error", onPost);
    socket.on("connect", refresh);
    window.addEventListener("online", refresh);
    return () => {
      socket.off("agent:board", onPost);
      socket.off("agent:subagent_status", onStatus);
      socket.off("agent:done", onPost);
      socket.off("agent:error", onPost);
      socket.off("connect", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [open, queryClient, sessionId]);

  const roster = data?.pages[0]?.participants ?? [];
  const messages = Array.from(
    new Map(
      (data?.pages.toReversed().flatMap((page) => page.messages) ?? []).map((message) => [
        message.id,
        message,
      ]),
    ).values(),
  );
  const label = (id: string) =>
    id === "ALL"
      ? t("assistant.agentBoard.all")
      : id === "main"
        ? t("assistant.agentBoard.main")
        : (roster.find((person) => person.id === id)?.label ?? id);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
    >
      <Dialog.Content
        className="agent-board-dialog"
        maxWidth="780px"
        aria-describedby="agent-board-description"
      >
        <Flex
          justify="between"
          align="center"
          gap="3"
        >
          <Dialog.Title mb="0">{t("assistant.agentBoard.title")}</Dialog.Title>
          <Flex gap="2">
            <IconButton
              variant="ghost"
              aria-label={t("assistant.agentBoard.refresh")}
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <RefreshCw size={16} />
            </IconButton>
            <Dialog.Close>
              <IconButton
                variant="ghost"
                aria-label={t("assistant.agentBoard.close")}
              >
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </Flex>
        </Flex>
        <Dialog.Description
          id="agent-board-description"
          mt="3"
          size="2"
        >
          {t("assistant.agentBoard.description")}
        </Dialog.Description>
        <Flex
          gap="2"
          wrap="wrap"
          my="3"
          aria-label={t("assistant.agentBoard.participants")}
        >
          {roster.map((person) => (
            <Badge
              key={person.id}
              color={person.active ? "blue" : "gray"}
              title={person.id}
            >
              {label(person.id)} ·{" "}
              {t(`assistant.agentBoard.states.${person.active ? person.state : "inactive"}`, {
                defaultValue: person.state,
              })}
            </Badge>
          ))}
          {data?.pages[0]?.participants_truncated && (
            <Text
              size="1"
              color="gray"
            >
              {t("assistant.agentBoard.moreParticipants")}
            </Text>
          )}
        </Flex>
        <Box
          className="agent-board-messages"
          aria-live="polite"
        >
          {isPending && <Text size="2">{t("assistant.agentBoard.loading")}</Text>}
          {isError && (
            <Flex
              gap="3"
              align="center"
            >
              <Text
                color="red"
                size="2"
              >
                {t("assistant.agentBoard.loadError")}
              </Text>
              <Button onClick={() => void refetch()}>{t("assistant.agentBoard.retry")}</Button>
            </Flex>
          )}
          {hasNextPage && (
            <Button
              variant="soft"
              size="1"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {t("assistant.agentBoard.earlier")}
            </Button>
          )}
          {!isPending && !isError && messages.length === 0 && (
            <Text
              as="p"
              color="gray"
              size="2"
            >
              {t("assistant.agentBoard.empty")}
            </Text>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className="agent-board-message"
              data-retracted={message.retracted}
              id={`board-${message.id}`}
            >
              <Flex
                gap="2"
                align="center"
                wrap="wrap"
              >
                <Badge
                  color={
                    message.type === "VETO"
                      ? "red"
                      : message.type === "HOLD"
                        ? "orange"
                        : message.type === "RESULT"
                          ? "green"
                          : "blue"
                  }
                >
                  {t(`assistant.agentBoard.kinds.${message.type}`)}
                </Badge>
                <Text
                  size="2"
                  weight="medium"
                  title={message.from}
                >
                  {label(message.from)} → {label(message.to)}
                </Text>
                <Text
                  size="1"
                  color="gray"
                >
                  #{message.seq} · {new Date(message.created_at).toLocaleString()}
                </Text>
                {message.retracted && (
                  <Badge color="gray">{t("assistant.agentBoard.retracted")}</Badge>
                )}
              </Flex>
              {message.reply_to && (
                <Text
                  as="p"
                  size="1"
                  color="gray"
                >
                  {t("assistant.agentBoard.replyTo", { id: message.reply_to })}
                </Text>
              )}
              <p className="agent-board-message-body">{message.body}</p>
            </article>
          ))}
        </Box>
        <Text
          as="p"
          size="1"
          color="gray"
          mt="3"
        >
          {t("assistant.agentBoard.advisory")}
        </Text>
      </Dialog.Content>
    </Dialog.Root>
  );
}
