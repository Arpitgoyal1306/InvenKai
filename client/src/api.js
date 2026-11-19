import { useQuery } from "@tanstack/react-query";

const backendUrl = (import.meta.env.VITE_API_URL || "").trim().replace(/\/+$/, "");
export const base = backendUrl + "/api";
export const tokenKey = "invenkai.session";

export async function api(
  path,
  { method = "GET", body, signal, publicRoute = false, credentials } = {},
) {
  const token = publicRoute ? null : sessionStorage.getItem(tokenKey);
  let response;
  try {
    response = await fetch(base + path, {
      method,
      signal,
      credentials,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      "Cannot reach the workspace API. Check the connection and try again.",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (
      token &&
      response.status === 401 &&
      token === sessionStorage.getItem(tokenKey)
    ) {
      window.dispatchEvent(new Event("session-expired"));
    }
    throw Object.assign(
      new Error(data.message || `Request failed (${response.status})`),
      { status: response.status },
    );
  }
  return data;
}

export function useData(path, enabled = true) {
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    enabled,
  });
}

export const amount = (value) =>
  Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const dateTime = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
