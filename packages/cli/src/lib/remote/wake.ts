import type { WakeRequest } from "@achq/core";

/** Asks the router to wake the container. It checks, on the repo's host, that you can push to the repo. */
export const wake = async (router: string, request: WakeRequest, token: string) => {
  const res = await fetch(`${router}/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`Couldn't wake ${request.container}: ${res.status} ${await res.text()}`);
};
