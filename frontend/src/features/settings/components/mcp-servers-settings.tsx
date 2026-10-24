import {
  Badge,
  Button,
  Dialog,
  Flex,
  IconButton,
  Select,
  Switch,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner, toast } from "@/components";

import {
  deleteMCPServer,
  fetchMCPServers,
  saveMCPServer,
  setMCPServerEnabled,
  testMCPServer,
  type MCPServer,
  type MCPServerWrite,
} from "../lib/mcp-servers-api";
import { AgentSettingsLockNotice } from "./agent-settings-lock-notice";

import "./mcp-servers-settings.css";

interface Props {
  mobilePage?: "list" | "detail";
  onMobilePageChange?: (page: "list" | "detail") => void;
  onMobileDetailTitleChange?: (title: string | null) => void;
  isAgentSettingsLocked?: boolean;
  isAgentSettingsLockLoading?: boolean;
}

function MCPServerForm({
  server,
  locked,
  onSaved,
}: {
  server: MCPServer | null;
  locked: boolean;
  onSaved: (server: MCPServer) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [transport, setTransport] = useState<MCPServer["transport"]>(
    server?.transport ?? "streamable_http",
  );
  const [headers, setHeaders] = useState("");
  const [isEnabled, setIsEnabled] = useState(server?.is_enabled ?? true);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<{ tool_names: string[] } | null>(null);
  const save = useMutation({
    mutationFn: (data: MCPServerWrite) => saveMCPServer(data, server?.id),
    onSuccess: (saved) => {
      onSaved(saved);
      toast.success(t("common.saveSuccess"));
    },
    onError: () => setError(t("mcp.saveFailed")),
  });
  const test = useMutation({
    mutationFn: () => testMCPServer(server!.id),
    onMutate: () => {
      setTestResult(null);
      setError("");
    },
    onSuccess: setTestResult,
    onError: () => setError(t("mcp.testFailed")),
  });
  const busy = locked || save.isPending || test.isPending;
  const dirty =
    name !== server?.name ||
    url !== server?.url ||
    transport !== server?.transport ||
    isEnabled !== server?.is_enabled ||
    !!headers.trim();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setTestResult(null);
    let parsedHeaders: Record<string, string> | undefined;
    if (headers.trim()) {
      try {
        const parsed: unknown = JSON.parse(headers);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          !Object.values(parsed).every((value) => typeof value === "string")
        )
          throw new Error();
        parsedHeaders = parsed as Record<string, string>;
      } catch {
        setError(t("mcp.invalidHeaders"));
        return;
      }
    }
    try {
      const parsed = new URL(url.trim());
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error();
    } catch {
      setError(t("mcp.invalidUrl"));
      return;
    }
    save.mutate({
      name: name.trim(),
      url: url.trim(),
      type: "remote",
      transport,
      headers: parsedHeaders,
      is_enabled: isEnabled,
    });
  }

  return (
    <form
      className="mcp-server-form"
      onSubmit={submit}
    >
      <Flex
        align="center"
        justify="between"
        gap="3"
      >
        <Text
          size="4"
          weight="medium"
        >
          {server?.name ?? t("mcp.add")}
        </Text>
        <Badge>Remote</Badge>
      </Flex>
      <AgentSettingsLockNotice isLocked={locked} />
      <Text
        size="2"
        color="gray"
      >
        {t("mcp.description")}
      </Text>
      <label htmlFor="mcp-name">
        <Text
          size="2"
          weight="medium"
        >
          {t("mcp.name")}
        </Text>
        <TextField.Root
          id="mcp-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          required
          disabled={busy}
        />
      </label>
      <label htmlFor="mcp-url">
        <Text
          size="2"
          weight="medium"
        >
          {t("mcp.url")}
        </Text>
        <TextField.Root
          id="mcp-url"
          type="url"
          placeholder="https://example.com/mcp"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          disabled={busy}
        />
      </label>
      <label htmlFor="mcp-transport">
        <Text
          size="2"
          weight="medium"
        >
          {t("mcp.transport")}
        </Text>
        <Select.Root
          value={transport}
          onValueChange={(value) => setTransport(value as MCPServer["transport"])}
          disabled={busy}
        >
          <Select.Trigger id="mcp-transport" />
          <Select.Content>
            <Select.Item value="streamable_http">Streamable HTTP</Select.Item>
            <Select.Item value="sse">SSE</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      <label htmlFor="mcp-headers">
        <Text
          size="2"
          weight="medium"
        >
          {t("mcp.headers")}
        </Text>
        <TextArea
          id="mcp-headers"
          value={headers}
          onChange={(event) => setHeaders(event.target.value)}
          placeholder={'{"Authorization": "Bearer …"}'}
          rows={4}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
        <Text
          size="1"
          color="gray"
        >
          {t("mcp.headersHint")}
        </Text>
        {server && server.header_names.length > 0 && (
          <Text
            size="1"
            color="gray"
          >
            {t("mcp.savedHeaders", { names: server.header_names.join(", ") })}
          </Text>
        )}
      </label>
      <label className="mcp-server-enabled">
        <Switch
          checked={isEnabled}
          onCheckedChange={setIsEnabled}
          disabled={busy}
        />
        {t("mcp.enabled")}
      </label>
      <Text
        size="2"
        color="gray"
      >
        {t("mcp.defaultHint")}
      </Text>
      {error && (
        <Text
          color="red"
          size="2"
          role="alert"
        >
          {error}
        </Text>
      )}
      {testResult && (
        <Flex
          direction="column"
          gap="1"
          role="status"
        >
          <Text
            color="green"
            size="2"
          >
            {t("mcp.testSuccess", { count: testResult.tool_names.length })}
          </Text>
          <Text
            size="1"
            color="gray"
          >
            {testResult.tool_names.join(", ")}
          </Text>
        </Flex>
      )}
      <Flex
        gap="3"
        wrap="wrap"
      >
        <Button
          type="submit"
          disabled={busy || !name.trim() || !url.trim() || !dirty}
          loading={save.isPending}
        >
          {t("common.save")}
        </Button>
        {server && (
          <Button
            type="button"
            variant="soft"
            disabled={busy || dirty}
            loading={test.isPending}
            onClick={() => test.mutate()}
          >
            {t("mcp.test")}
          </Button>
        )}
      </Flex>
      {server && dirty && (
        <Text
          size="1"
          color="gray"
        >
          {t("mcp.saveBeforeTest")}
        </Text>
      )}
    </form>
  );
}

export function MCPServersSettings({
  mobilePage = "list",
  onMobilePageChange,
  onMobileDetailTitleChange,
  isAgentSettingsLocked = false,
  isAgentSettingsLockLoading = false,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<MCPServer | null>(null);
  const {
    data: servers = [],
    isLoading,
    error,
    refetch,
  } = useQuery({ queryKey: ["mcp-servers"], queryFn: fetchMCPServers });
  const selected =
    servers.find((server) => server.id === selectedId) ??
    (selectedId === "new" ? null : (servers[0] ?? null));
  const locked = isAgentSettingsLocked || isAgentSettingsLockLoading;
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setMCPServerEnabled(id, enabled),
    onSuccess: invalidate,
    onError: () => toast.error(t("mcp.saveFailed")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteMCPServer(id),
    onSuccess: () => {
      setDeleting(null);
      setSelectedId(null);
      onMobilePageChange?.("list");
      invalidate();
    },
    onError: () => toast.error(t("mcp.deleteFailed")),
  });
  useEffect(() => {
    onMobileDetailTitleChange?.(selectedId === "new" ? t("mcp.add") : (selected?.name ?? null));
  }, [selectedId, selected?.name, onMobileDetailTitleChange, t]);

  if (isLoading)
    return (
      <Flex
        align="center"
        justify="center"
        height="100%"
      >
        <Spinner size={18} />
      </Flex>
    );
  if (error)
    return (
      <Flex
        direction="column"
        gap="3"
        p="4"
      >
        <Text color="red">{t("mcp.loadFailed")}</Text>
        <Button onClick={() => void refetch()}>{t("mcp.retry")}</Button>
      </Flex>
    );
  return (
    <div className={`mcp-settings mcp-settings--${mobilePage}`}>
      <div className="mcp-settings-list">
        <Flex
          gap="2"
          p="3"
          align="center"
        >
          <TextField.Root
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("mcp.search")}
            style={{ flex: 1, minWidth: 0 }}
            aria-label={t("mcp.search")}
          >
            <TextField.Slot>
              <Search size={16} />
            </TextField.Slot>
          </TextField.Root>
          <IconButton
            aria-label={t("mcp.add")}
            disabled={locked}
            onClick={() => {
              setSelectedId("new");
              onMobilePageChange?.("detail");
            }}
          >
            <Plus size={16} />
          </IconButton>
        </Flex>
        <div className="mcp-settings-list-body">
          {servers.length === 0 && (
            <Text
              as="p"
              color="gray"
              size="2"
            >
              {t("mcp.empty")}
            </Text>
          )}
          {servers.length > 0 &&
            !servers.some((server) => server.name.toLowerCase().includes(search.toLowerCase())) && (
              <Text
                as="p"
                color="gray"
                size="2"
              >
                {t("mcp.noResults")}
              </Text>
            )}
          {servers
            .filter((server) => server.name.toLowerCase().includes(search.toLowerCase()))
            .map((server) => (
              <div
                className={`mcp-settings-list-item ${selected?.id === server.id ? "mcp-settings-list-item--selected" : ""}`}
                key={server.id}
              >
                <button
                  className="mcp-settings-select"
                  onClick={() => {
                    setSelectedId(server.id);
                    onMobilePageChange?.("detail");
                  }}
                >
                  <Server size={16} />
                  <span>{server.name}</span>
                </button>
                <Switch
                  size="1"
                  aria-label={t("mcp.toggle", { name: server.name })}
                  checked={server.is_enabled}
                  disabled={locked || toggle.isPending}
                  onCheckedChange={(enabled) => toggle.mutate({ id: server.id, enabled })}
                />
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-label={t("mcp.delete", { name: server.name })}
                  disabled={locked || remove.isPending}
                  onClick={() => setDeleting(server)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
        </div>
      </div>
      <div className="mcp-settings-detail">
        {selected || selectedId === "new" ? (
          <MCPServerForm
            key={selected ? `${selected.id}:${selected.updated_at}` : "new"}
            server={selected}
            locked={locked || toggle.isPending}
            onSaved={(saved) => {
              queryClient.setQueryData<MCPServer[]>(["mcp-servers"], (previous = []) => [
                ...previous.filter((item) => item.id !== saved.id),
                saved,
              ]);
              setSelectedId(saved.id);
              invalidate();
            }}
          />
        ) : (
          <Flex
            direction="column"
            align="center"
            justify="center"
            height="100%"
            gap="3"
          >
            <Server size={32} />
            <Text
              size="2"
              color="gray"
            >
              {t("mcp.selectHint")}
            </Text>
          </Flex>
        )}
      </div>
      <Dialog.Root
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <Dialog.Content maxWidth="440px">
          <Dialog.Title>{t("mcp.delete", { name: deleting?.name })}</Dialog.Title>
          <Dialog.Description>{t("mcp.deleteConfirm")}</Dialog.Description>
          <Flex
            gap="3"
            justify="end"
            mt="4"
          >
            <Button
              variant="soft"
              color="gray"
              disabled={remove.isPending}
              onClick={() => setDeleting(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              color="red"
              disabled={locked || remove.isPending}
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {t("common.delete")}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
