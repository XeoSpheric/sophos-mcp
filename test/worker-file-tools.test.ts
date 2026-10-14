/**
 * The three tools that read or wrote local files before the Workers port:
 * the firewall backup now returns its download link, the firewall import
 * takes base64 or an https URL, and the case file upload takes content only.
 * fetch is stubbed; no network.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SophosClient } from "../src/client/sophos-client.ts";
import { registerFirewallTools } from "../src/tools/firewall.ts";
import { registerFusionCaseTools } from "../src/tools/fusion-cases.ts";
import { bytesToBase64, md5Hex, utf8Bytes } from "../src/util.ts";
import { connect, json, jsonResponse, stubFetch, text } from "./harness.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const HOST = "https://api-au01.central.sophos.com";
const FW1 = "659240aa-797e-42cf-bb82-cca43c4e80d8";
const CASE_ID = "659240aa-797e-42cf-bb82-cca43c4e80d8";
const ARCHIVE = utf8Bytes("firewall-config-archive-bytes");

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function firewallTools(reply: (url: string, init: RequestInit) => Response, allowWrites = false) {
  const sent: Sent[] = [];
  restore = stubFetch((url, init) => {
    sent.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    return reply(url, init);
  });
  const tokenManager = { getToken: async () => "fake-token" };
  const tenantResolver: any = { resolveApiHost: async () => HOST, resolveTenantId: (id?: string) => id ?? TENANT };
  const mcp = connect((server) => registerFirewallTools(server, new SophosClient(tokenManager, tenantResolver), tenantResolver), {
    allowWrites,
  });
  return { sent, mcp };
}

test("the backup download returns the pre-signed URL, size and MD5, and is read-only", async () => {
  const url = "https://s3.example/backup.tar?sig=abc";
  const { sent, mcp } = firewallTools((u) =>
    u === url
      ? new Response(ARCHIVE, { status: 200 })
      : jsonResponse({ status: "finished", result: "success", response: { url, expiresAt: "2099-01-01T00:00:00Z", firewallId: FW1 } }),
  );
  const result = await mcp.callTool({ name: "sophos_download_firewall_backup", arguments: { transaction_id: "txn-1" } });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(json(result), {
    status: "ready",
    transaction_id: "txn-1",
    firewall_id: FW1,
    download_url: url,
    expires_at: "2099-01-01T00:00:00Z",
    file_size_bytes: ARCHIVE.length,
    checksum_md5: md5Hex(ARCHIVE),
  });
  const download = sent.find((s) => s.url === url)!;
  assert.equal(download.headers.Authorization, undefined, "no Sophos token on the pre-signed URL");
  assert.ok(!mcp.registry.isWrite("sophos_download_firewall_backup"));
});

async function callImport(args: Record<string, unknown>, sourceReply?: Response) {
  const { sent, mcp } = firewallTools((u) => {
    if (u === "https://store.example/archive") return sourceReply ?? new Response(ARCHIVE, { status: 200 });
    if (u === "https://upload.example/put") return new Response(null, { status: 200 });
    if (u.endsWith("/firewall/v1/firewall-config/firewalls/import")) {
      return jsonResponse({ transactionId: "txn-9", url: "https://upload.example/put", method: "PUT" });
    }
    return jsonResponse({ status: "in_progress" });
  }, true);
  const result = await mcp.callTool({ name: "sophos_import_firewall_config", arguments: { firewall_ids: [FW1], ...args } });
  return { result, sent };
}

test("the import uploads base64 content and reports its MD5 and size", async () => {
  const { result, sent } = await callImport({ content_base64: bytesToBase64(ARCHIVE) });
  assert.equal(result.isError, undefined, text(result));
  const put = sent.find((s) => s.url === "https://upload.example/put")!;
  assert.deepEqual(new Uint8Array(put.body as Uint8Array), ARCHIVE);
  const complete = sent.find((s) => s.url.endsWith("/import/txn-9/upload-complete"))!;
  assert.deepEqual(JSON.parse(complete.body as string), {
    firewallIds: [FW1],
    checksumMd5: md5Hex(ARCHIVE),
    fileSizeBytes: ARCHIVE.length,
    performPartialImport: true,
  });
});

test("the import fetches source_url without the Sophos token", async () => {
  const { result, sent } = await callImport({ source_url: "https://store.example/archive" });
  assert.equal(result.isError, undefined, text(result));
  const source = sent.find((s) => s.url === "https://store.example/archive")!;
  assert.equal(source.headers.Authorization, undefined);
  assert.equal(JSON.parse(sent.find((s) => s.url.endsWith("/upload-complete"))!.body as string).checksumMd5, md5Hex(ARCHIVE));
});

test("the import needs exactly one source, an https URL, and valid base64", async () => {
  for (const [args, pattern] of [
    [{}, /exactly one of source_url or content_base64/],
    [{ content_base64: "AAAA", source_url: "https://store.example/archive" }, /exactly one/],
    [{ source_url: "http://store.example/archive" }, /Invalid arguments for tool sophos_import_firewall_config: source_url/],
    [{ content_base64: "not base64!" }, /content_base64 is not valid base64/],
  ] as const) {
    const { result, sent } = await callImport(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(text(result), pattern);
    assert.equal(sent.length, 0, "nothing is sent");
  }
  const failed = await callImport({ source_url: "https://store.example/archive" }, new Response("gone", { status: 403 }));
  assert.match(text(failed.result), /Archive download from source_url failed \(403\)/);
  assert.ok(!failed.sent.some((s) => s.url.endsWith("/import")), "no import is started");
});

test("the case file upload takes content or content_base64, never a path", async () => {
  const sent: { document: string; variables: any }[] = [];
  const puts: Uint8Array[] = [];
  const client: any = {
    query: async (_tenant: string, document: string, variables: any) => {
      sent.push({ document, variables });
      if (document.startsWith("mutation FusionStartCaseFileUpload(")) {
        return {
          data: {
            startCaseFileUpload: {
              presignedUrl: "https://upload.example/file",
              file: { id: "f1", name: variables.input.name, size: variables.input.size, status: "UPLOADED", contentType: variables.input.contentType },
            },
          },
          warnings: [],
        };
      }
      throw new Error(`unexpected document: ${document.slice(0, 40)}`);
    },
    putPresigned: async (_url: string, bytes: Uint8Array) => {
      puts.push(bytes);
    },
  };
  const resolver: any = { resolveTenantId: (id?: string) => id ?? TENANT };
  const mcp = connect((server) => registerFusionCaseTools(server, client, resolver, {} as any));
  const call = (args: Record<string, unknown>) =>
    mcp.callTool({ name: "sophos_fusion_upload_case_file", arguments: { case_id: CASE_ID, ...args } });

  let r = await call({ name: "notes.txt", content: "hello" });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(puts[0], utf8Bytes("hello"));
  assert.equal(sent[0]!.variables.input.contentType, "text/plain");

  r = await call({ name: "blob", content_base64: bytesToBase64(ARCHIVE) });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(puts[1], ARCHIVE);
  assert.equal(sent[1]!.variables.input.contentType, "application/octet-stream");

  r = await call({ content: "hello" });
  assert.match(text(r), /Invalid arguments for tool sophos_fusion_upload_case_file: name: Required/);
  r = await call({ name: "x.txt", content: "a", content_base64: "YQ==" });
  assert.match(text(r), /exactly one of content or content_base64/);
  r = await call({ name: "x.txt", file_path: "/etc/passwd" });
  assert.match(text(r), /exactly one of content or content_base64/, "file_path is not an argument any more");
  assert.equal(puts.length, 2);
});
