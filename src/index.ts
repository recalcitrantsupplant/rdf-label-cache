import { handleLabel } from "./routes/label";
import { handleContext } from "./routes/context";
import { handleNamespaces } from "./routes/namespaces";
import { handleDevSeed } from "./routes/dev-seed";
import { handleDevLoad } from "./routes/dev-load";
import { handlePurge } from "./routes/purge";

const PUBLIC_PATHS = new Set(["/label", "/context/labels-v1.json", "/namespaces"]);
const PUBLIC_METHODS = "GET, HEAD, OPTIONS";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const isPublicPath = PUBLIC_PATHS.has(pathname);

    // Cache purge is POST + authenticated; handle before the GET-only guard.
    if (pathname === "/admin/purge") {
      return handlePurge(request, env, ctx);
    }

    // Dev-only bulk loader (POST); handle before the GET-only guard.
    if (pathname === "/dev/load" && env.ENVIRONMENT !== "production") {
      return handleDevLoad(request, env);
    }

    if (request.method === "OPTIONS" && isPublicPath) {
      return publicCors(new Response(null, { status: 204, headers: { Allow: PUBLIC_METHODS } }));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      const response = new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: isPublicPath ? PUBLIC_METHODS : "GET" },
      });
      return isPublicPath ? publicCors(response) : response;
    }

    if (pathname === "/dev/seed" && env.ENVIRONMENT !== "production") {
      return handleDevSeed(request, env);
    }

    let response: Response;
    if (pathname === "/label") {
      response = await handleLabel(request, env);
    } else if (pathname === "/context/labels-v1.json") {
      response = await handleContext(env);
    } else if (pathname === "/namespaces") {
      response = handleNamespaces();
    } else {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    response = publicCors(response);
    if (request.method === "HEAD") {
      // /label already served HEAD via R2 `head`; other routes may still carry
      // a stream - cancel it rather than dropping it unconsumed.
      await response.body?.cancel();
      return new Response(null, responseInit(response, new Headers(response.headers)));
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

function publicCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", PUBLIC_METHODS);
  return new Response(response.body, responseInit(response, headers));
}

function responseInit(response: Response, headers: Headers): ResponseInit {
  return { status: response.status, statusText: response.statusText, headers };
}
