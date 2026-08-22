import test from "node:test";
import assert from "node:assert/strict";
import { PROJECTION_MODEL_VERSION } from "../app/lib/fpl.ts";
import { MODEL_RELEASES, comparableModelRows, groupByModelVersion, modelDisplayName, modelRelease, modelVersionKey } from "../app/lib/model-version.ts";

test("model registry identifies the projection engine's current release",()=>{
  const release=modelRelease(PROJECTION_MODEL_VERSION);
  assert.ok(release);
  assert.equal(release.current,true);
  assert.equal(MODEL_RELEASES.filter(item=>item.current).length,1);
});

test("unknown and legacy model versions remain explicit instead of being relabelled current",()=>{
  assert.equal(modelRelease("future-unknown"),null);
  assert.equal(modelDisplayName("future-unknown"),"future-unknown");
  assert.equal(modelDisplayName(null),"Legacy / unversioned");
  assert.equal(modelVersionKey(null),"legacy");
});

test("accuracy cohorts group and select model generations without pooling them",()=>{
  const rows=[{id:1,version:"r-a"},{id:2,version:"r-b"},{id:3,version:"r-a"},{id:4,version:null}];
  const grouped=groupByModelVersion(rows,row=>row.version);
  assert.deepEqual(grouped.get("r-a")?.map(row=>row.id),[1,3]);
  assert.deepEqual(grouped.get("r-b")?.map(row=>row.id),[2]);
  assert.deepEqual(grouped.get("legacy")?.map(row=>row.id),[4]);
  assert.deepEqual(comparableModelRows(rows,"r-a",row=>row.version).map(row=>row.id),[1,3]);
});
