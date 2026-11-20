import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { base, tokenKey } from "./api";

export function useMarketLive(owner, userId) {
  const client = useQueryClient();
  const session = owner ? (userId ?? null) : "public";
  const [connected, setConnected] = useState(null);

  useEffect(() => {
    setConnected(null);
    if (session === null) return;
    let stopped = false;
    let controller, retry, refresh, heartbeat;

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
    function watchHeartbeat() {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => controller.abort(), 45000);
    }

    async function connect() {
      controller = new AbortController();
      let ready = false;
      watchHeartbeat();
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
          watchHeartbeat();
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop();
          if (frames.some((frame) => frame === "data: refresh")) {
            if (!ready && !stopped) {
              ready = true;
              setConnected({ owner, session });
            }
            invalidate();
          }
        }
      } catch {
        // Disconnected views keep polling until the stream is ready again.
      } finally {
        clearTimeout(heartbeat);
        if (!stopped) {
          setConnected(null);
          retry = setTimeout(connect, 2500);
        }
      }
    }
    connect();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(retry);
      clearTimeout(refresh);
      clearTimeout(heartbeat);
    };
  }, [owner, session, client]);

  return connected?.owner === owner && connected?.session === session;
}
