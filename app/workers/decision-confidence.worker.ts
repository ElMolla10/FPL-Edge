/// <reference lib="webworker" />

import {
  DecisionConfidenceWorkerRequest,
  executeDecisionConfidenceWorkerRequest,
} from "../lib/decision-confidence-worker";

self.onmessage = (event: MessageEvent<DecisionConfidenceWorkerRequest>) => {
  self.postMessage(executeDecisionConfidenceWorkerRequest(event.data));
};

