/**
 * Registers every tool module the way the Worker does (registerAllTools on a
 * fresh ToolRegistry) and lists the tools. No credentials and no network:
 * registration never calls Sophos. Proves the server still exposes the 283
 * Classic tools plus the 21 Fusion case tools and the Fusion detection
 * search, and that the descriptions carry the measured warnings.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildServices, registerAllTools } from "../src/session.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const FUSION_CASE_TOOLS = [
  "sophos_fusion_list_cases",
  "sophos_fusion_get_case",
  "sophos_fusion_get_case_evidence",
  "sophos_fusion_get_case_summary",
  "sophos_fusion_list_case_reference_data",
  "sophos_fusion_create_case",
  "sophos_fusion_update_case",
  "sophos_fusion_split_case",
  "sophos_fusion_merge_cases",
  "sophos_fusion_list_case_comments",
  "sophos_fusion_add_case_comment",
  "sophos_fusion_update_case_comment",
  "sophos_fusion_delete_case_comment",
  "sophos_fusion_add_case_evidence",
  "sophos_fusion_remove_case_evidence",
  "sophos_fusion_list_case_files",
  "sophos_fusion_upload_case_file",
  "sophos_fusion_delete_case_file",
  "sophos_fusion_create_case_link",
  "sophos_fusion_update_case_link",
  "sophos_fusion_delete_case_link",
];

const FUSION_DETECTION_TOOLS = ["sophos_fusion_search_detections"];

const CLASSIC_DETECTION_TOOLS = [
  "sophos_run_detections_query",
  "sophos_get_detections_run",
  "sophos_get_detections_results",
  "sophos_run_detection_groups_query",
  "sophos_get_detection_groups_run",
  "sophos_get_detection_groups_results",
];

const CLASSIC_CASE_TOOLS = [
  "sophos_list_cases",
  "sophos_get_case",
  "sophos_create_case",
  "sophos_update_case",
  "sophos_delete_case",
  "sophos_list_case_detections",
  "sophos_get_case_detection",
  "sophos_list_case_impacted_entities",
  "sophos_get_case_mitre_summary",
];

// Tool shapes are checked as plain JSON, the way a client sees tools/list.
type Tool = any;

function listAllTools(): { registry: ToolRegistry; tools: Tool[] } {
  const registry = new ToolRegistry();
  // The identity is unknown until whoami runs, so the partner tools register too.
  registerAllTools(registry, buildServices({ clientId: "x", clientSecret: "y" }));
  return { registry, tools: registry.list(true) };
}

test("tools/list exposes the 283 Classic tools plus the 22 Fusion tools", () => {
  const { tools } = listAllTools();
  const names = new Set(tools.map((t) => t.name));

  assert.equal(tools.length, 305);
  assert.equal(names.size, 305, "tool names are unique");

  for (const name of CLASSIC_CASE_TOOLS) assert.ok(names.has(name), `${name} still registered`);
  for (const name of CLASSIC_DETECTION_TOOLS) assert.ok(names.has(name), `${name} still registered`);
  for (const name of FUSION_CASE_TOOLS) assert.ok(names.has(name), `${name} registered`);
  for (const name of FUSION_DETECTION_TOOLS) assert.ok(names.has(name), `${name} registered`);
});

test("every Fusion case tool has a schema, annotations and dash-free prose", () => {
  const { tools } = listAllTools();
  for (const tool of tools.filter((t) => t.name.startsWith("sophos_fusion_"))) {
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} has an object input schema`);
    assert.ok(tool.inputSchema.properties, `${tool.name} declares properties`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} has readOnlyHint`);
    assert.ok(tool.description.length > 100, `${tool.name} has a description`);
    assert.doesNotMatch(tool.description, /[\u2013\u2014]/, `${tool.name} description has no en or em dash`);
  }
  const readOnly = tools.filter((t) => t.name.startsWith("sophos_fusion_") && t.annotations.readOnlyHint);
  assert.equal(readOnly.length, 8, "eight Fusion tools are read-only");
});

test("the firewall backup download writes no local file, so it is read-only and takes no output_path", () => {
  const { tools } = listAllTools();
  const download = tools.find((t) => t.name === "sophos_download_firewall_backup");
  assert.equal(download.annotations.readOnlyHint, true, "it only returns a download link");
  assert.equal(download.annotations.destructiveHint, false);
  assert.equal(download.inputSchema.properties.output_path, undefined, "no filesystem on a Worker");
  const imp = tools.find((t) => t.name === "sophos_import_firewall_config");
  assert.equal(imp.inputSchema.properties.file_path, undefined, "no filesystem on a Worker");
});

test("the read-only listing excludes every tool not annotated readOnlyHint: true", () => {
  const { registry, tools } = listAllTools();
  const readOnlyList = registry.list(false);
  const listed = new Set(readOnlyList.map((t: Tool) => t.name));
  const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  assert.ok(writes.length > 0, "there are write tools");
  assert.ok(readOnlyList.length > 0, "there are read-only tools");
  assert.equal(readOnlyList.length + writes.length, tools.length);
  for (const tool of writes) assert.ok(!listed.has(tool.name), `${tool.name} is hidden when writes are off`);
  for (const tool of readOnlyList) assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`);
  for (const tool of tools) assert.equal(registry.isWrite(tool.name), tool.annotations?.readOnlyHint !== true, tool.name);
});

test("Classic case and detection tools name the migration refusal and the Fusion tool to use", () => {
  const { tools } = listAllTools();
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  for (const name of [...CLASSIC_CASE_TOOLS, ...CLASSIC_DETECTION_TOOLS]) {
    const tool = byName.get(name);
    assert.match(tool.description, /Refused for a tenant that has migrated to Sophos Fusion/, name);
    assert.match(tool.description, /use sophos_fusion_[a-z_]+/, `${name} names a Fusion tool`);
    assert.doesNotMatch(tool.description, /deprecated/i, `${name} carries no blanket deprecation label`);
    assert.doesNotMatch(tool.description, /[\u2013\u2014]/, `${name} description has no en or em dash`);
  }
});

test("the write tools carry the measured warnings and the guards in their schemas", () => {
  const { tools } = listAllTools();
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const expect = (name: string, pattern: RegExp) => assert.match(byName.get(name).description, pattern, `${name}: ${pattern}`);

  // managed_by: required, no default, irreversible, unclaimed if omitted, pinned by type
  const create = byName.get("sophos_fusion_create_case");
  assert.ok(create.inputSchema.required.includes("managed_by"), "create_case requires managed_by");
  assert.equal(create.inputSchema.properties.managed_by.default, undefined, "managed_by has no default");
  assert.deepEqual(create.inputSchema.properties.managed_by.enum, ["PROVIDER", "CUSTOMER"]);
  for (const key of ["queue", "rule_id", "template_id", "incident_advisor_id"]) {
    assert.equal(create.inputSchema.properties[key], undefined, `${key} is not a create_case argument`);
  }
  expect("sophos_fusion_create_case", /PROVIDER hands it to Sophos MDR/);
  expect("sophos_fusion_create_case", /cannot be changed after creation/);
  expect("sophos_fusion_create_case", /unclaimed/);
  expect("sophos_fusion_create_case", /health_check and threat_hunt always use PROVIDER/);

  // split and merge: destructive, irreversible, confirmation argument
  for (const [name, flag] of [["sophos_fusion_split_case", "confirm_split"], ["sophos_fusion_merge_cases", "confirm_merge"]]) {
    const tool = byName.get(name);
    assert.ok(tool.inputSchema.required.includes(flag), `${name} requires ${flag}`);
    assert.equal(tool.annotations.destructiveHint, true, `${name} is marked destructive`);
    expect(name, /irreversible/);
  }
  assert.ok(byName.get("sophos_fusion_split_case").inputSchema.required.includes("new_managed_by"));
  expect("sophos_fusion_merge_cases", /Asynchronous/);
  expect("sophos_fusion_merge_cases", /keep their own evidence rows/);

  // files: soft delete
  expect("sophos_fusion_delete_case_file", /SOFT delete/);
  expect("sophos_fusion_list_case_files", /hidden unless include_deleted/);

  // tags: replace versus merge
  expect("sophos_fusion_update_case", /replaces the whole tag list/);
  expect("sophos_fusion_update_case", /merges yours in/);
  expect("sophos_fusion_update_case", /cannot return to it/);

  // mentions fire from prose and unresolved ones are reported
  expect("sophos_fusion_add_case_comment", /explanatory prose/);
  expect("sophos_fusion_add_case_comment", /mentions_unresolved/);

  // evidence: RNs, expansion, source ids, lag
  expect("sophos_fusion_add_case_evidence", /also attaches its linked asset and events/);
  expect("sophos_fusion_remove_case_evidence", /SOURCE IDs/);
  expect("sophos_fusion_remove_case_evidence", /silent no-op/);
  expect("sophos_fusion_add_case_evidence", /land category by category/);
  expect("sophos_fusion_update_case", /refused before any write/);
  expect("sophos_fusion_update_case", /verdict "" clears/);
  expect("sophos_fusion_search_detections", /0 to 1 float/);
});

test("the policy write tools explain assignment kinds, the endpoint group companion and the listing lag", () => {
  const { tools } = listAllTools();
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const expect = (name: string, pattern: RegExp) => assert.match(byName.get(name).description, pattern, `${name}: ${pattern}`);
  for (const name of ["sophos_create_policy", "sophos_update_policy", "sophos_set_policy_assignments"]) {
    const tool = byName.get(name);
    for (const key of ["users", "user_groups", "endpoints", "endpoint_groups"]) {
      assert.equal(tool.inputSchema.properties[key]?.type, "array", `${name} takes ${key}`);
      assert.equal(tool.inputSchema.properties[key].items.format, "uuid", `${name} ${key} are plain IDs`);
    }
    expect(name, /kind\s+follows\s+which\s+keys/);
    expect(name, /endpoint_groups is always\s+sent with an endpoints key/);
    expect(name, /server-\*/);
    expect(name, /assignment_stored/);
    assert.doesNotMatch(tool.description, /[\u2013\u2014]/, `${name} description has no en or em dash`);
  }
  expect("sophos_update_policy", /REPLACE the policy's\s+whole\s+assignment/);
  expect("sophos_create_policy", /up to about 25\s+seconds/);
  expect("sophos_list_policies", /measured\s+1\.6 to 21\.8 s/);
  const clone = byName.get("sophos_clone_policy");
  for (const key of ["users", "user_groups", "endpoints", "endpoint_groups"]) {
    assert.equal(clone.inputSchema.properties[key]?.items?.format, "uuid", `clone takes ${key}`);
  }
  expect("sophos_clone_policy", /same path as\s+sophos_set_policy_assignments/);
  expect("sophos_create_policy", /defaults a policy created\s+through the API to\s+endpoint\.web-control\.web-profile\.enabled true/);
  expect("sophos_create_policy", /false \(legacy\s+settings\) otherwise/);
  expect("sophos_update_policy", /only sticks when\s+filter-by-web-profile\.enabled is true/);
  for (const name of ["sophos_create_policy", "sophos_set_policy_assignments"]) {
    expect(name, /server\s+endpoint or group on a computer policy/);
  }
  for (const name of [
    "sophos_clone_policy",
    "sophos_list_policies",
    "sophos_get_policy",
    "sophos_create_web_filtering_profile",
    "sophos_update_web_filtering_profile",
  ]) {
    assert.doesNotMatch(byName.get(name).description, /[\u2013\u2014]/, `${name} description has no en or em dash`);
  }
  const set = byName.get("sophos_set_policy_assignments");
  assert.deepEqual(set.inputSchema.properties.mode.enum, ["replace", "add", "remove"]);
  assert.ok(set.inputSchema.required.includes("mode"), "mode is required");
  assert.equal(set.annotations.destructiveHint, true, "replace and remove can drop assignments");
});
