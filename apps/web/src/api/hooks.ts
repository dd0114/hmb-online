import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { components } from "./schema";
import { useToken } from "../auth/TokenContext";

export type MeResponse = components["schemas"]["MeResponse"];
export type ModeInfo = components["schemas"]["ModeInfo"];

/** GET /api/me — nickname/points/records header data (LLD-web §2 /lobby). */
export function useMe() {
  const { token } = useToken();
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/api/me"),
    enabled: Boolean(token),
  });
}

/** GET /api/modes — mode select modal (싱글 available, 멀티 준비중 — D10). */
export function useModes(enabled: boolean = true) {
  const { token } = useToken();
  return useQuery({
    queryKey: ["modes"],
    queryFn: () => apiFetch<ModeInfo[]>("/api/modes"),
    enabled: Boolean(token) && enabled,
  });
}
