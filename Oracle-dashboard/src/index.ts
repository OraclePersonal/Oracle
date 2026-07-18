import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryRouter } from "./api/memory.js";
import { messagesRouter } from "./api/messages.js";
import { statusRouter } from "./api/status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3456", 10);

const app = express();

app.use(express.static(path.resolve(__dirname, "..", "public")));
app.use("/api/memory", memoryRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/status", statusRouter);

app.listen(PORT, () => {
  console.log(`Oracle Dashboard → http://localhost:${PORT}`);
});
