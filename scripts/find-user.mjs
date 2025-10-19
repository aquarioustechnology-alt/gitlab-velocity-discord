import dotenv from "dotenv";
import axios from "axios";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const rawToken = process.env.GITLAB_TOKEN || "";
const token = rawToken.replace(/^"|"$/g, "");

if (!token) {
  console.error("Missing GITLAB_TOKEN in environment.");
  process.exit(1);
}

const query = process.argv[2];

if (!query) {
  console.error("Usage: node scripts/find-user.mjs <username-or-search>");
  process.exit(1);
}

const client = axios.create({
  baseURL: "https://gitlab.com/api/v4",
  headers: { "PRIVATE-TOKEN": token }
});

try {
  const res = await client.get("/users", {
    params: { search: query, per_page: 100 }
  });
  if (!Array.isArray(res.data) || !res.data.length) {
    console.log(`No users found for search: ${query}`);
    process.exit(0);
  }
  for (const user of res.data) {
    console.log(`${user.id}\t${user.username}\t${user.name}`);
  }
} catch (err) {
  console.error("Failed to lookup users:", err?.response?.data || err.message);
  process.exit(1);
}
