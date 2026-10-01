import { Container } from "@cloudflare/containers";
import { handleIngest } from "./part2";

export class LivePublisherContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = false;
  allowedHosts = ["ingest.worker"];
}

LivePublisherContainer.outboundByHost = {
  "ingest.worker": async (request: Request, env: Env): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${env.INGEST_SECRET}`);
    return handleIngest(new Request(request, { headers }), env);
  },
};
