import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const fixtureDirectory = new URL("../fixtures/", import.meta.url);
const template = await readFile(
  new URL("index.html", fixtureDirectory),
  "utf8",
);
const frame = await readFile(new URL("frame.html", fixtureDirectory));
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let page = 1; page <= 2; page++) {
  const sheet = pdf.addPage([612, 792]);
  sheet.drawText(`LongCap sample PDF - page ${page}`, {
    x: 48,
    y: 720,
    size: 20,
    font,
    color: rgb(0, 0, 0),
  });
}
const pdfBytes = await pdf.save();
const routes = new Set([
  "/",
  "/grid",
  "/short",
  "/axes",
  "/nested",
  "/sticky",
  "/lazy",
  "/reverse",
  "/virtual",
  "/canvas",
  "/frames",
  "/mask",
  "/batch1",
  "/batch2",
]);
let crossOrigin;

function handler(req, res) {
  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  };
  let pathname;
  try {
    pathname = new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    res.writeHead(400, headers).end("Bad request");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, headers).end();
    return;
  }
  let body;
  let type;
  let status = 200;
  if (routes.has(pathname)) {
    body = template.replace(
      "__CROSS_ORIGIN_JSON__",
      JSON.stringify(crossOrigin).replaceAll("<", "\\u003c"),
    );
    type = "text/html; charset=utf-8";
  } else if (pathname === "/frame.html") {
    body = frame;
    type = "text/html; charset=utf-8";
  } else if (pathname === "/sample.pdf") {
    body = pdfBytes;
    type = "application/pdf";
  } else if (pathname === "/fail") {
    body = "Intentional fixture failure";
    type = "text/plain; charset=utf-8";
    status = 500;
  } else {
    body = "Not found";
    type = "text/plain; charset=utf-8";
    status = 404;
  }
  res.writeHead(status, { ...headers, "Content-Type": type });
  res.end(req.method === "HEAD" ? undefined : body);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}
const requestedPort = process.env.LOCAL_CAPTURE_PORT;
if (
  requestedPort !== undefined &&
  (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535)
)
  throw new Error("LOCAL_CAPTURE_PORT must be a port from 0 to 65535");
const secondary = createServer(handler);
const main = createServer(handler);
try {
  const secondaryPort = await listen(secondary, 0);
  crossOrigin = `http://127.0.0.1:${secondaryPort}`;
  const mainPort = await listen(
    main,
    requestedPort === undefined ? 0 : Number(requestedPort),
  );
  console.log(`Main URL: http://127.0.0.1:${mainPort}`);
  console.log(`Cross-origin URL: ${crossOrigin}`);
} catch (error) {
  secondary.close();
  throw error;
}
function shutdown() {
  main.close();
  secondary.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
