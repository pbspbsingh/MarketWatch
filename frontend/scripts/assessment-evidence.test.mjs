import assert from "node:assert/strict";
import test from "node:test";
import { availableEvidence, evidenceError } from "../src/components/assessmentEvidence.ts";

const snapshot = {
  quarters: [{ fiscal_period: "2026Q2" }, { fiscal_period: "2022Q3" }],
  annual: [{ fiscal_period: "2025FY" }, { fiscal_period: "2026FY" }],
  quarter_forecasts: [{ fiscal_period: "2026Q3" }, { fiscal_period: null }],
};

test("citations use the saved quarterly, annual and forecast periods", () => {
  const available = availableEvidence(snapshot);
  assert.deepEqual([...available], ["2026Q2", "2022Q3", "2025FY", "2026FY", "2026Q3"]);
  assert.equal(evidenceError([...available], available), undefined);
  assert.deepEqual([...availableEvidence({ ...snapshot, annual: null })], ["2026Q2", "2022Q3", "2026Q3"]);
});

test("MXL's unsupported 2022Q2 citation is identified without altering valid citations", () => {
  const ids = ["2026Q2", "2022Q2", "2022Q2"];
  const available = availableEvidence(snapshot);
  assert.equal(evidenceError(ids, available), "Not in supplied data: 2022Q2.");
  assert.equal(evidenceError(["2026Q2"], available), undefined);
  assert.deepEqual(ids, ["2026Q2", "2022Q2", "2022Q2"]);
});

test("missing citations are flagged for scored criteria and concerns", () => {
  const available = availableEvidence(snapshot);
  assert.equal(evidenceError([], available), "No financial periods cited.");
  assert.equal(evidenceError([], available, false), undefined);
  assert.equal(evidenceError(["2022Q2"], available, false), "Not in supplied data: 2022Q2.");
});
