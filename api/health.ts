/**
 * Health check — no auth, no SDK imports. Confirms the runtime works.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    env_present: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      GITHUB_REPO_OWNER: !!process.env.GITHUB_REPO_OWNER,
      GITHUB_REPO_NAME: !!process.env.GITHUB_REPO_NAME,
      GITHUB_BRANCH: !!process.env.GITHUB_BRANCH,
      MCP_BEARER_TOKEN: !!process.env.MCP_BEARER_TOKEN,
    },
  });
}
