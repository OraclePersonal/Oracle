import { Router, type Request, type Response } from "express";

const startTime = Date.now();

export const statusRouter = Router();

statusRouter.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    server: "oracle-dashboard",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

statusRouter.get("/peers", (_req: Request, res: Response) => {
  res.json([]);
});
