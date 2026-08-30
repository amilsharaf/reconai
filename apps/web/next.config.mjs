import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This is a single-app workspace (apps/web) with its .env at the repo root,
// not inside apps/web itself — Next.js only auto-loads .env files from its
// own directory, so without this, every server-side process.env.* read
// (Server Components, route handlers) would see undefined.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../.env") });

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
