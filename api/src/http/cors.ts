import { cors } from "hono/cors";

export function apiCors(webOrigin: string) {
  return cors({
    origin: (origin) => (origin === new URL(webOrigin).origin ? origin : undefined),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  });
}
