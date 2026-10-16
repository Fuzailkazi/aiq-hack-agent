import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";

export function useHackathon(hid: string) {
  return useQuery({
    queryKey: ["hackathon", hid],
    enabled: hid !== "",
    queryFn: async () => unwrap(await api.GET("/api/hackathons/{hid}", { params: { path: { hid } } })),
  });
}
