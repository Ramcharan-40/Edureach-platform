import express from "express";
import type { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.ts";
import errorHandler from "./middleware/error-handler.middleware.ts";
import chatRoutes from "./routes/chat.routes.ts";
import vapiRoutes from "./routes/vapi.routes.ts";
import connectDB from "./config/database.config.ts";

const app: Application = express();
 
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        "https://edureach-platform-vert.vercel.app",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
      ];
      if (!origin || allowedOrigins.includes(origin) || origin.startsWith("http://localhost:")) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Database auto-connection middleware for serverless/express requests
app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "EduReach API is running.",
    endpoints: {
      auth: "/api/auth",
      chat: "/api/chat",
      vapi: "/api/vapi",
    },
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/vapi", vapiRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: "Route not found." });
});

app.use(errorHandler);

export default app;