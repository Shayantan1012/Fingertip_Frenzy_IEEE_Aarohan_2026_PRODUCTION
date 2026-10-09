export const API_BASE_URL = "/api/v1";
let authEpoch = 0;
export const bumpAuthEpoch = () => {
  authEpoch++;
  window.dispatchEvent(new Event("auth-changing"));
};
export async function apiFetch(url, options = {}) {
  const epoch = authEpoch;
  const res = await fetch(url, {
    ...options,
    credentials: "same-origin",
    signal: options.signal || AbortSignal.timeout(15000),
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401 && epoch === authEpoch && !url.includes("/auth/"))
    window.dispatchEvent(new Event("session-expired"));
  return res;
}
export async function request(path, options = {}) {
  const res = await apiFetch("/api" + path, {
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `The server returned an unreadable response (${res.status}). Please try again.`,
    );
  }
  if (!res.ok) {
    const error = new Error(
      data.message || "Request failed. Please try again.",
    );
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}
