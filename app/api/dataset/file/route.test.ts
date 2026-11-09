// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const handleDatasetFileRequest = vi.fn();
const handleDatasetHeadRequest = vi.fn();
vi.mock("@/lib/dataset-download", () => ({
  handleDatasetFileRequest: (request: Request) => handleDatasetFileRequest(request),
  handleDatasetHeadRequest: (request: Request) => handleDatasetHeadRequest(request),
}));

import * as route from "./route";

beforeEach(() => {
  handleDatasetFileRequest.mockReset();
  handleDatasetHeadRequest.mockReset();
});

describe("GET /api/dataset/file", () => {
  it("hands the request to the download handler and returns its response untouched", async () => {
    const response = new Response("file body", { status: 200 });
    handleDatasetFileRequest.mockResolvedValue(response);
    const request = new Request("http://localhost/api/dataset/file?t=x&f=README.txt");

    const result = await route.GET(request);

    expect(handleDatasetFileRequest).toHaveBeenCalledWith(request);
    expect(result).toBe(response);
  });

  it("is dynamic, so a tokened download is never prerendered", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("exports GET and HEAD and no other verb", () => {
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "HEAD"]);
  });
});

describe("HEAD /api/dataset/file", () => {
  it("is answered by the head handler, never the download handler", () => {
    const response = new Response(null, { status: 405 });
    handleDatasetHeadRequest.mockReturnValue(response);
    const request = new Request("http://localhost/api/dataset/file?t=x&f=README.txt", { method: "HEAD" });

    const result = route.HEAD(request);

    expect(handleDatasetHeadRequest).toHaveBeenCalledWith(request);
    expect(result).toBe(response);
    expect(handleDatasetFileRequest).not.toHaveBeenCalled();
  });
});
