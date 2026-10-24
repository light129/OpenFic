import { apiClient } from "@/lib/api-client";

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  type: "remote";
  transport: "streamable_http" | "sse";
  header_names: string[];
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface MCPServerWrite {
  name: string;
  url: string;
  type: "remote";
  transport: MCPServer["transport"];
  headers?: Record<string, string>;
  is_enabled: boolean;
}

export async function fetchMCPServers(): Promise<MCPServer[]> {
  return (await apiClient.get<MCPServer[]>("/mcp-servers")).data;
}

export async function saveMCPServer(data: MCPServerWrite, id?: string): Promise<MCPServer> {
  return id
    ? (await apiClient.put<MCPServer>(`/mcp-servers/${id}`, data)).data
    : (await apiClient.post<MCPServer>("/mcp-servers", data)).data;
}

export async function setMCPServerEnabled(id: string, isEnabled: boolean): Promise<MCPServer> {
  return (await apiClient.patch<MCPServer>(`/mcp-servers/${id}/enabled`, { is_enabled: isEnabled }))
    .data;
}

export async function deleteMCPServer(id: string): Promise<void> {
  await apiClient.delete(`/mcp-servers/${id}`);
}

export async function testMCPServer(id: string): Promise<{ tool_names: string[] }> {
  return (await apiClient.post<{ tool_names: string[] }>(`/mcp-servers/${id}/test`)).data;
}
