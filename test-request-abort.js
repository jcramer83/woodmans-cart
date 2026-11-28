// A response that dies mid-body must reject. It used to hang forever.
const assert = require("assert");
const http = require("http");
const { request } = require("./cart-worker-fast");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":');
    res.destroy();
  });
  const port = await listen(server);
  const started = Date.now();
  let rejected = null;
  try {
    await request({ url: "http://127.0.0.1:" + port + "/cut", timeoutMs: 5000 });
  } catch (err) {
    rejected = err;
  } finally {
    server.close();
  }
  const elapsed = Date.now() - started;
  assert.ok(rejected, "request should reject when the body is cut off");
  assert.ok(elapsed < 4000, "request hung for " + elapsed + "ms");
  assert.ok(!/password|cookie|token/i.test(String(rejected.message)), "error text leaked a secret");
  console.log("request abort test passed (" + rejected.message + ")");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
