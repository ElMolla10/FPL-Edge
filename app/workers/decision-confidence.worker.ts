/// <reference lib="webworker" />

import {
  DecisionConfidenceWorkerRequest,
  TransferDecisionConfidenceWorkerRequest,
  executeDecisionConfidenceWorkerRequest,
  executeTransferDecisionConfidenceWorkerRequest,
} from "../lib/decision-confidence-worker";

self.onmessage = (event: MessageEvent<DecisionConfidenceWorkerRequest | TransferDecisionConfidenceWorkerRequest>) => {
  if (event.data.type === "analyze-transfer") {
    executeTransferDecisionConfidenceWorkerRequest(event.data, response => self.postMessage(response));
    return;
  }
  self.postMessage(executeDecisionConfidenceWorkerRequest(event.data));
};
