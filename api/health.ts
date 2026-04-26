/**
 * Minimal health-check endpoint. Verifies that Web-style handlers run on Vercel's Node runtime.
 * If this 500s while api/mcp.ts also 500s, the handler signature itself is wrong.
 * If this returns 200 while api/mcp.ts 500s, the MCP SDK import is the problem.
 */

export const config = {
  runtime: "nodejs",
};

export default async function handler(_req: Request): Promise<Response> {
  return new Response(
    JSON.stringify({
      ok: true,
      runtime: "nodejs",
      time: new Date().toISOString(),
      env_present: {
        GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
        GITHUB_REPO_OWNER: !!process.env.GITHUB_REPO_OWNER,
        GITHUB_REPO_NAME: !!process.env.GITHUB_REPO_NAME,
        GITHUB_BRANCH: !!process.env.GITHUB_BRANCH,
        MCP_BEARER_TOKEN: !!process.env.MCP_BEARER_TOKEN,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}
