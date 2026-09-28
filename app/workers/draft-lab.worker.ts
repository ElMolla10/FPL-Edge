/// <reference lib="webworker" />

import {
  executeDraftLabOptimizeRequest,
  type DraftLabOptimizeRequest,
  type DraftLabWorkerResponse,
} from "../lib/draft-lab-worker";

self.onmessage = (event: MessageEvent<DraftLabOptimizeRequest>) => {
  if (event.data?.type !== "optimize") return;
  const response: DraftLabWorkerResponse = executeDraftLabOptimizeRequest(event.data, (progress) => {
    self.postMessage(progress);
  });
  self.postMessage(response);
};
