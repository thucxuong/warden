// One React Query hook per endpoint (design 8.3 "React Query").

import { useQuery } from "@tanstack/react-query";
import type {
  DocsResponse, EventsResponse, HealthResponse, HomeResponse, LogResponse, RunDetailResponse, RunsResponse,
  SignalsResponse, TicketsResponse,
} from "@api";
import { getJson, getText } from "@/lib/api";

const enc = encodeURIComponent;

export const useHome = () => useQuery({ queryKey: ["home"], queryFn: () => getJson<HomeResponse>("/api/home") });
export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: () => getJson<HealthResponse>("/api/health") });
export const useTickets = () => useQuery({ queryKey: ["tickets"], queryFn: () => getJson<TicketsResponse>("/api/tickets") });
export const useSignals = () => useQuery({ queryKey: ["signals"], queryFn: () => getJson<SignalsResponse>("/api/signals") });

/** `params` is the /api/runs query string without "?". */
export const useRuns = (params: string) =>
  useQuery({ queryKey: ["runs", params], queryFn: () => getJson<RunsResponse>(`/api/runs${params ? `?${params}` : ""}`) });

export const useRun = (task: string) =>
  useQuery({ queryKey: ["run", task], queryFn: () => getJson<RunDetailResponse>(`/api/runs/${enc(task)}`) });

export const useEvents = (task: string, enabled: boolean) =>
  useQuery({ queryKey: ["events", task], queryFn: () => getJson<EventsResponse>(`/api/runs/${enc(task)}/events`), enabled });

export const useLog = (task: string, path: string, lines: number, enabled: boolean) =>
  useQuery({
    queryKey: ["log", task, path, lines],
    queryFn: () => getJson<LogResponse>(`/api/runs/${enc(task)}/log?path=${enc(path)}&lines=${lines}`),
    enabled,
  });

export const useDocs = () => useQuery({ queryKey: ["docs"], queryFn: () => getJson<DocsResponse>("/api/docs") });

export const useDoc = (path: string | null) =>
  useQuery({
    queryKey: ["doc", path],
    queryFn: () => getText(`/api/doc?path=${enc(path ?? "")}&format=html`),
    enabled: path !== null,
  });
