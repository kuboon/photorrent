import { createHtmlResponse } from "@remix-run/response/html";
import { shellHtml } from "../ui/shell.ts";

/** GET / — serve the app shell; the browser drives everything after load. */
export const homeAction = {
  handler() {
    return createHtmlResponse(shellHtml());
  },
};
