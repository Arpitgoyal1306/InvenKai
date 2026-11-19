import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { base, tokenKey } from "./api";

export function useMarketLive(owner, userId) {
  const client = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    let retry, refresh;
    function invalidate() {
      if (refresh) return;
      refresh = setTimeout(() => {
        refresh = null;
        client.invalidateQueries({
          predicate: ({ queryKey: [path] }) =>
            typeof path === "string" &&
            (owner
              ? path.startsWith("/market/owner")
              : path.startsWith("/market/stores")),
        });
      }, 50);
    }
    async function connect() {
      try {
        const response = await fetch(
          base + (owner ? "/market/owner/live" : "/market/live"),
          {
            signal: controller.signal,
            headers: owner
              ? { Authorization: "Bearer " + sessionStorage.getItem(tokenKey) }
              : {},
          },
        );
        if (!response.ok) throw new Error("Stream unavailable");
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop();
          if (frames.some((frame) => frame === "data: refresh")) invalidate();
        }
      } catch {
        /* The regular catalog refresh remains active while reconnecting. */
      }
      if (!controller.signal.aborted) retry = setTimeout(connect, 2500);
    }
    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearTimeout(refresh);
    };
  }, [owner, userId, client]);
}
