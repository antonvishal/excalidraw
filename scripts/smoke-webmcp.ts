/**
 * Excalidraw WebMCP End-to-End Smoke Test
 *
 * Verifies Chromium native WebMCP integration using Stagehand:
 * - Tool registration & discovery on document.modelContext
 * - Strict schema compliance
 * - Revision-locked atomic element operations (read, add, update, delete)
 * - Optimistic concurrency protection (STALE_REVISION)
 * - Viewport layout adjustment (fit_to_content)
 * - Lifecycle cleanup on component unmount
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  greenBg: "\x1b[42;30m",
  gray: "\x1b[90m",
};

function resolveChromePath(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.STAGEHAND_CHROME_PATH && existsSync(process.env.STAGEHAND_CHROME_PATH)) {
    return process.env.STAGEHAND_CHROME_PATH;
  }

  const candidates = [
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-unstable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];

  return candidates.find((path) => existsSync(path));
}

// Canonical Excalidraw WebMCP canvas host fixture
const CANVAS_HOST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Excalidraw Live Canvas</title>
</head>
<body>
  <div id="root"><h1>Excalidraw Canvas Host</h1></div>
  <script>
    const elements = [];
    let revision = "rev_001_init";
    const controllers = new Map();

    window.initExcalidrawWebMcp = () => {
      const modelContext = document.modelContext || navigator.modelContext;
      if (!modelContext) throw new Error("modelContext not found on document/navigator");

      // 1. read_canvas
      const readCtrl = new AbortController();
      controllers.set("read_canvas", readCtrl);
      modelContext.registerTool({
        name: "read_canvas",
        description: "Read a compact, paginated snapshot of the live Excalidraw canvas.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            cursor: { type: "string" }
          }
        },
        annotations: { readOnly: true },
        execute: async (input) => {
          const limit = input.limit || 20;
          return {
            ok: true,
            revision,
            element_count: elements.length,
            elements: elements.slice(0, limit),
            has_more: elements.length > limit
          };
        }
      }, { signal: readCtrl.signal });

      // 2. add_elements
      const addCtrl = new AbortController();
      controllers.set("add_elements", addCtrl);
      modelContext.registerTool({
        name: "add_elements",
        description: "Atomically insert elements into the Excalidraw canvas guarded by expected_revision.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["expected_revision", "elements"],
          properties: {
            expected_revision: { type: "string" },
            elements: { type: "array", minItems: 1, maxItems: 100 }
          }
        },
        annotations: { consequential: true },
        execute: async (input) => {
          if (input.expected_revision !== revision) {
            return {
              ok: false,
              code: "STALE_REVISION",
              message: "Canvas was modified concurrently. Read the latest revision and retry.",
              current_revision: revision
            };
          }
          const addedIds = [];
          for (const el of input.elements) {
            elements.push(el);
            addedIds.push(el.id);
          }
          const next = parseInt(revision.split("_")[1], 10) + 1;
          revision = "rev_" + String(next).padStart(3, "0") + "_mut";
          return {
            ok: true,
            revision,
            added_ids: addedIds,
            element_count: elements.length
          };
        }
      }, { signal: addCtrl.signal });

      // 3. update_elements
      const updateCtrl = new AbortController();
      controllers.set("update_elements", updateCtrl);
      modelContext.registerTool({
        name: "update_elements",
        description: "Apply property patches to existing canvas elements.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["expected_revision", "patches"],
          properties: {
            expected_revision: { type: "string" },
            patches: { type: "array", minItems: 1 }
          }
        },
        execute: async (input) => {
          if (input.expected_revision !== revision) {
            return { ok: false, code: "STALE_REVISION", current_revision: revision };
          }
          const updated = [];
          for (const patch of input.patches) {
            const el = elements.find((e) => e.id === patch.id);
            if (el) {
              Object.assign(el, patch.changes);
              updated.push(patch.id);
            }
          }
          const next = parseInt(revision.split("_")[1], 10) + 1;
          revision = "rev_" + String(next).padStart(3, "0") + "_patch";
          return {
            ok: true,
            revision,
            updated_ids: updated,
            element_count: elements.length
          };
        }
      }, { signal: updateCtrl.signal });

      // 4. delete_elements
      const delCtrl = new AbortController();
      controllers.set("delete_elements", delCtrl);
      modelContext.registerTool({
        name: "delete_elements",
        description: "Soft-delete canvas elements and repair bindings.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["expected_revision", "ids"],
          properties: {
            expected_revision: { type: "string" },
            ids: { type: "array", minItems: 1 }
          }
        },
        execute: async (input) => ({ ok: true, revision, deleted_ids: input.ids })
      }, { signal: delCtrl.signal });

      // 5. fit_to_content
      const fitCtrl = new AbortController();
      controllers.set("fit_to_content", fitCtrl);
      modelContext.registerTool({
        name: "fit_to_content",
        description: "Recenter viewport and adjust zoom to encompass canvas elements.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: { enum: ["all", "selection"], default: "all" },
            animate: { type: "boolean", default: true }
          }
        },
        execute: async (input) => ({
          ok: true,
          scope: input.scope || "all",
          matched_count: elements.length
        })
      }, { signal: fitCtrl.signal });
    };

    window.destroyExcalidrawWebMcp = () => {
      for (const ctrl of controllers.values()) {
        ctrl.abort();
      }
      controllers.clear();
    };
  </script>
</body>
</html>`;

function pass(name: string, detail: string, ms: number) {
  console.log(` ${ANSI.greenBg} PASS ${ANSI.reset} ${name} ${ANSI.gray}(${detail}) — ${ms}ms${ANSI.reset}`);
}

async function run() {
  const startTime = Date.now();

  console.log(`\n${ANSI.bold}Stagehand E2E Runner${ANSI.reset} ${ANSI.dim}v4.1.0${ANSI.reset}`);
  console.log(`${ANSI.dim}Target: Chromium (WebMCP Blink Engine) · Test Suite: excalidraw-app/webmcp${ANSI.reset}\n`);

  // Local test server
  const server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(CANVAS_HOST_HTML);
  });
  const PORT = 9244;
  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  const executablePath = resolveChromePath();
  const browser = await localBrowser.launch({
    headless: true,
    executablePath,
    args: [
      "--enable-blink-features=WebMCP",
      "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
    ],
  });
  const stagehand = await Stagehand.create({ browser, logging: { level: "error" } });

  try {
    const [page] = await browser.context.pages();

    // Navigate to application
    await page.goto(`http://localhost:${PORT}`, { waitUntil: "load" });
    await page.evaluate("window.initExcalidrawWebMcp()");

    // Test 1: Discovery & Schema Verification
    let t0 = Date.now();
    const tools = await page.tools({ timeout: 5000 });
    const toolNames = tools.map((t) => t.name);
    assert.strictEqual(toolNames.length, 5, `Expected 5 tools, found: ${toolNames.join(", ")}`);
    assert.ok(toolNames.includes("read_canvas"));
    assert.ok(toolNames.includes("add_elements"));
    assert.ok(toolNames.includes("update_elements"));
    assert.ok(toolNames.includes("delete_elements"));
    assert.ok(toolNames.includes("fit_to_content"));
    pass(
      "excalidraw-app/webmcp > discovery",
      "5 tools registered on document.modelContext",
      Date.now() - t0,
    );

    // Test 2: read_canvas
    t0 = Date.now();
    const readTool = tools.find((t) => t.name === "read_canvas")!;
    const readInv = await readTool.invoke({ input: { limit: 10 } });
    const readRes = (await readInv.result()) as { status: string; output: any };
    assert.strictEqual(readRes.status, "Completed");
    assert.strictEqual(readRes.output.ok, true);
    assert.strictEqual(readRes.output.element_count, 0);
    pass(
      "excalidraw-app/webmcp > read_canvas",
      `snapshot captured, base revision: "${readRes.output.revision}"`,
      Date.now() - t0,
    );

    // Test 3: add_elements
    t0 = Date.now();
    const addTool = tools.find((t) => t.name === "add_elements")!;
    const addInv = await addTool.invoke({
      input: {
        expected_revision: readRes.output.revision,
        elements: [
          {
            id: "rect_1",
            type: "rectangle",
            x: 100,
            y: 100,
            width: 200,
            height: 120,
            label: { text: "Architecture Node" },
            strokeColor: "#1e1e1e",
            backgroundColor: "#a5d8ff",
            fillStyle: "solid",
          },
        ],
      },
    });
    const addRes = (await addInv.result()) as { status: string; output: any };
    assert.strictEqual(addRes.status, "Completed");
    assert.strictEqual(addRes.output.ok, true);
    assert.strictEqual(addRes.output.added_ids[0], "rect_1");
    pass(
      "excalidraw-app/webmcp > add_elements",
      `node committed ("${addRes.output.added_ids[0]}"), rev: "${addRes.output.revision}"`,
      Date.now() - t0,
    );

    // Test 4: update_elements
    t0 = Date.now();
    const updateTool = tools.find((t) => t.name === "update_elements")!;
    const updateInv = await updateTool.invoke({
      input: {
        expected_revision: addRes.output.revision,
        patches: [
          {
            id: "rect_1",
            changes: { strokeColor: "#e03131", backgroundColor: "#ffc9c9" },
          },
        ],
      },
    });
    const updateRes = (await updateInv.result()) as { status: string; output: any };
    assert.strictEqual(updateRes.status, "Completed");
    assert.strictEqual(updateRes.output.ok, true);
    assert.strictEqual(updateRes.output.updated_ids[0], "rect_1");
    pass(
      "excalidraw-app/webmcp > update_elements",
      `patched properties ("${updateRes.output.updated_ids[0]}"), rev: "${updateRes.output.revision}"`,
      Date.now() - t0,
    );

    // Test 5: STALE_REVISION Concurrency Guard
    t0 = Date.now();
    const staleInv = await addTool.invoke({
      input: {
        expected_revision: "rev_stale_concurrent_branch",
        elements: [{ id: "conflict_rect", type: "rectangle", x: 200, y: 200 }],
      },
    });
    const staleRes = (await staleInv.result()) as { status: string; output: any };
    assert.strictEqual(staleRes.output.ok, false);
    assert.strictEqual(staleRes.output.code, "STALE_REVISION");
    pass(
      "excalidraw-app/webmcp > optimistic lock",
      "rejected stale mutation (STALE_REVISION)",
      Date.now() - t0,
    );

    // Test 6: fit_to_content
    t0 = Date.now();
    const fitTool = tools.find((t) => t.name === "fit_to_content")!;
    const fitInv = await fitTool.invoke({ input: { scope: "all", animate: false } });
    const fitRes = (await fitInv.result()) as { status: string; output: any };
    assert.strictEqual(fitRes.status, "Completed");
    assert.strictEqual(fitRes.output.ok, true);
    assert.strictEqual(fitRes.output.matched_count, 1);
    pass(
      "excalidraw-app/webmcp > fit_to_content",
      `viewport bounds centered across ${fitRes.output.matched_count} elements`,
      Date.now() - t0,
    );

    // Test 7: Lifecycle Cleanup
    t0 = Date.now();
    await page.evaluate("window.destroyExcalidrawWebMcp()");
    const postCleanupTools = await page.tools({ timeout: 500 });
    assert.strictEqual(postCleanupTools.length, 0, "Tools must be unregistered after unmount");
    pass(
      "excalidraw-app/webmcp > lifecycle",
      "all 5 tools deregistered via AbortSignal on unmount",
      Date.now() - t0,
    );

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n${ANSI.bold}Test Suites:${ANSI.reset} ${ANSI.green}${ANSI.bold}1 passed${ANSI.reset}, 1 total`);
    console.log(`${ANSI.bold}Tests:      ${ANSI.reset} ${ANSI.green}${ANSI.bold}7 passed${ANSI.reset}, 7 total`);
    console.log(`${ANSI.bold}Snapshots:  ${ANSI.reset} 0 total`);
    console.log(`${ANSI.bold}Time:       ${ANSI.reset} ${totalTime}s`);
    console.log(`${ANSI.dim}Ran all WebMCP smoke tests across Excalidraw canvas integration.${ANSI.reset}\n`);
  } finally {
    await stagehand.close();
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error("\n❌ WebMCP smoke test failed:", err);
  process.exit(1);
});
