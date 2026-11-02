import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("batch all-sites access is optional, not an install-time host permission", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(!manifest.permissions.includes("<all_urls>"));
});

test("MV3 executable sources exclude blob workers and remote code", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  const directives = new Map<string, string[]>(
    manifest.content_security_policy.extension_pages
      .split(";")
      .map((directive: string) => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        return [name, sources];
      }),
  );
  const scriptSources = directives.get("script-src");
  assert.ok(scriptSources?.includes("'self'"));
  for (const name of ["script-src", "worker-src", "object-src"]) {
    const sources = directives.get(name) ?? scriptSources;
    assert.ok(sources?.length, `${name} must restrict executable sources`);
    for (const source of sources) {
      assert.ok(
        source === "'self'" ||
          source === "'none'" ||
          (name === "script-src" && source === "'wasm-unsafe-eval'"),
        `${name} contains an unsupported MV3 executable source: ${source}`,
      );
    }
  }
});
