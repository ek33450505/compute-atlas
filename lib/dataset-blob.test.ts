import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    put: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    list: vi.fn(),
  };
});

vi.mock("@vercel/blob", () => sdk);

import {
  DATASET_EDITION_FILES,
  DatasetBlobError,
  deleteEditionPrefix,
  editionPathname,
  getEditionFile,
  getEditionFileText,
  putEditionFile,
} from "./dataset-blob";

// An SDK error text that must never reach a caller (URLs and tokens can ride on it).
const SDK_SECRET = "https://store.private.blob.vercel-storage.com/x?token=vercel_blob_rw_SECRET";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function expectSyncCode(fn: () => unknown, code: string) {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DatasetBlobError);
  expect((err as DatasetBlobError).code).toBe(code);
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatasetBlobError);
  expect((err as DatasetBlobError).code).toBe(code);
  expect((err as DatasetBlobError).message).not.toContain("SECRET");
  expect((err as DatasetBlobError).message).not.toContain("https://");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("editionPathname", () => {
  it("builds editions/<date>/<name> for every allowlisted file", () => {
    for (const name of DATASET_EDITION_FILES) {
      expect(editionPathname("2026-11-09", name)).toBe(`editions/2026-11-09/${name}`);
    }
  });

  it.each([
    "../facilities.json",
    "..",
    "a/facilities.json",
    "facilities.json/",
    "a\\facilities.json",
    "%2e%2e",
    "%2efacilities.json",
    "facilities%2ejson",
    "Facilities.json",
    "FACILITIES.JSON",
    "facilities.json ",
    "facilities.json\0",
    "secrets.json",
    "",
  ])("rejects name %j", (name) => {
    expectSyncCode(() => editionPathname("2026-11-09", name), "blob_invalid_path");
  });

  it.each([
    "2026-13-01",
    "2026-02-30",
    "2026-00-10",
    "2026-01-00",
    "20261109",
    "2026-1-9",
    "2026-11-09/..",
    "../2026-11-09",
    " 2026-11-09",
    "2026-11-09\n",
    "",
  ])("rejects date %j", (date) => {
    expectSyncCode(() => editionPathname(date, "facilities.json"), "blob_invalid_path");
  });

  it("accepts a leap day and rejects a non-leap one", () => {
    expect(editionPathname("2028-02-29", "README.txt")).toBe("editions/2028-02-29/README.txt");
    expectSyncCode(() => editionPathname("2027-02-29", "README.txt"), "blob_invalid_path");
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
  });
});

describe("putEditionFile", () => {
  it("uploads privately, to the exact pathname, with no random suffix and overwrite allowed", async () => {
    sdk.put.mockResolvedValue({ pathname: "ignored" });
    await putEditionFile("2026-11-09", "facilities.json", "{}");
    expect(sdk.put).toHaveBeenCalledTimes(1);
    const [pathname, , options] = sdk.put.mock.calls[0];
    expect(pathname).toBe("editions/2026-11-09/facilities.json");
    expect(options).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("returns the UTF-8 byte length and a sha256 computed locally", async () => {
    sdk.put.mockResolvedValue({});
    const abc = await putEditionFile("2026-11-09", "README.txt", "abc");
    expect(abc).toEqual({
      pathname: "editions/2026-11-09/README.txt",
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });

    const body = "Zürich \u{1F4A1}"; // multi-byte characters
    const res = await putEditionFile("2026-11-09", "changelog.json", body);
    expect(res.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(res.bytes).toBeGreaterThan(body.length);
    expect(res.sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });

  it("sends the body to the SDK byte-for-byte", async () => {
    sdk.put.mockResolvedValue({});
    const body = "Zürich";
    await putEditionFile("2026-11-09", "facilities.csv", body);
    const sent = sdk.put.mock.calls[0][1];
    expect(Buffer.from(sent).toString("utf8")).toBe(body);
  });

  it("validates before calling the SDK", async () => {
    await expectCode(putEditionFile("2026-11-09", "../x", "b"), "blob_invalid_path");
    await expectCode(putEditionFile("2026-02-30", "README.txt", "b"), "blob_invalid_path");
    expect(sdk.put).not.toHaveBeenCalled();
  });

  it("wraps an SDK failure in a DatasetBlobError without echoing the SDK text", async () => {
    sdk.put.mockRejectedValue(new Error(SDK_SECRET));
    await expectCode(putEditionFile("2026-11-09", "README.txt", "b"), "blob_put_failed");
  });
});

describe("getEditionFile", () => {
  it("reads privately and returns the stream", async () => {
    const stream = streamOf("hello");
    sdk.get.mockResolvedValue({ statusCode: 200, stream, headers: new Headers(), blob: {} });
    const out = await getEditionFile("editions/2026-11-09/facilities.json");
    expect(out).toBe(stream);
    expect(sdk.get).toHaveBeenCalledWith(
      "editions/2026-11-09/facilities.json",
      expect.objectContaining({ access: "private" }),
    );
  });

  it("returns null when the SDK reports not found (null result)", async () => {
    sdk.get.mockResolvedValue(null);
    expect(await getEditionFile("editions/2026-11-09/facilities.json")).toBeNull();
  });

  it("returns null when the SDK throws BlobNotFoundError", async () => {
    sdk.get.mockRejectedValue(new sdk.BlobNotFoundError(SDK_SECRET));
    expect(await getEditionFile("editions/2026-11-09/facilities.json")).toBeNull();
  });

  it.each([
    "facilities.json",
    "/editions/2026-11-09/facilities.json",
    "editions/2026-11-09/../2026-11-08/facilities.json",
    "editions/2026-11-09/other.json",
    "editions/2026-11-09/Facilities.json",
    "editions/2026-11-09/facilities.json/",
    "editions/2026-02-30/facilities.json",
    "editions/2026-11-09/sub/facilities.json",
    "https://store.private.blob.vercel-storage.com/editions/2026-11-09/facilities.json",
    "other/2026-11-09/facilities.json",
    "",
  ])("refuses pathname %j without calling the SDK", async (pathname) => {
    await expectCode(getEditionFile(pathname), "blob_invalid_path");
    await expectCode(getEditionFileText(pathname), "blob_invalid_path");
    expect(sdk.get).not.toHaveBeenCalled();
  });

  it("wraps an SDK failure in a DatasetBlobError without echoing the SDK text", async () => {
    sdk.get.mockRejectedValue(new Error(SDK_SECRET));
    await expectCode(getEditionFile("editions/2026-11-09/facilities.json"), "blob_get_failed");
  });

  it("treats a non-200 result as a failure", async () => {
    sdk.get.mockResolvedValue({ statusCode: 304, stream: null, headers: new Headers(), blob: {} });
    await expectCode(getEditionFile("editions/2026-11-09/facilities.json"), "blob_get_failed");
  });
});

describe("getEditionFileText", () => {
  it("buffers the stream into a UTF-8 string", async () => {
    sdk.get.mockResolvedValue({ statusCode: 200, stream: streamOf("Zürich"), headers: new Headers(), blob: {} });
    expect(await getEditionFileText("editions/2026-11-09/README.txt")).toBe("Zürich");
  });

  it("returns null when the file is not found", async () => {
    sdk.get.mockResolvedValue(null);
    expect(await getEditionFileText("editions/2026-11-09/README.txt")).toBeNull();
  });

  it("wraps a stream read failure in a DatasetBlobError", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(SDK_SECRET));
      },
    });
    sdk.get.mockResolvedValue({ statusCode: 200, stream: broken, headers: new Headers(), blob: {} });
    await expectCode(getEditionFileText("editions/2026-11-09/README.txt"), "blob_get_failed");
  });
});

describe("deleteEditionPrefix", () => {
  const prefix = "editions/2026-11-09/";

  it("lists by the exact prefix and deletes only those pathnames", async () => {
    sdk.list.mockResolvedValue({
      blobs: [{ pathname: `${prefix}facilities.json` }, { pathname: `${prefix}README.txt` }],
      hasMore: false,
    });
    sdk.del.mockResolvedValue(undefined);
    expect(await deleteEditionPrefix("2026-11-09")).toBe(2);
    expect(sdk.list).toHaveBeenCalledWith(expect.objectContaining({ prefix }));
    expect(sdk.del).toHaveBeenCalledTimes(1);
    expect(sdk.del.mock.calls[0][0]).toEqual([`${prefix}facilities.json`, `${prefix}README.txt`]);
  });

  it("never deletes a listed pathname outside the prefix", async () => {
    sdk.list.mockResolvedValue({
      blobs: [{ pathname: `${prefix}README.txt` }, { pathname: "editions/2026-11-08/README.txt" }],
      hasMore: false,
    });
    sdk.del.mockResolvedValue(undefined);
    expect(await deleteEditionPrefix("2026-11-09")).toBe(1);
    expect(sdk.del.mock.calls[0][0]).toEqual([`${prefix}README.txt`]);
  });

  it("follows pagination cursors before deleting", async () => {
    sdk.list
      .mockResolvedValueOnce({ blobs: [{ pathname: `${prefix}a` }], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ blobs: [{ pathname: `${prefix}b` }], hasMore: false });
    sdk.del.mockResolvedValue(undefined);
    expect(await deleteEditionPrefix("2026-11-09")).toBe(2);
    expect(sdk.list.mock.calls[1][0]).toMatchObject({ prefix, cursor: "c1" });
    expect(sdk.del.mock.calls[0][0]).toEqual([`${prefix}a`, `${prefix}b`]);
  });

  it("returns 0 and skips del when nothing is listed", async () => {
    sdk.list.mockResolvedValue({ blobs: [], hasMore: false });
    expect(await deleteEditionPrefix("2026-11-09")).toBe(0);
    expect(sdk.del).not.toHaveBeenCalled();
  });

  it("validates the date before calling the SDK", async () => {
    await expectCode(deleteEditionPrefix("2026-13-01"), "blob_invalid_path");
    await expectCode(deleteEditionPrefix("../"), "blob_invalid_path");
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.del).not.toHaveBeenCalled();
  });

  it("maps a list failure to blob_list_failed without echoing the SDK text", async () => {
    sdk.list.mockRejectedValue(new Error(SDK_SECRET));
    await expectCode(deleteEditionPrefix("2026-11-09"), "blob_list_failed");
    expect(sdk.del).not.toHaveBeenCalled();
  });

  it("maps a delete failure to blob_delete_failed without echoing the SDK text", async () => {
    sdk.list.mockResolvedValue({ blobs: [{ pathname: `${prefix}a` }], hasMore: false });
    sdk.del.mockRejectedValue(new Error(SDK_SECRET));
    await expectCode(deleteEditionPrefix("2026-11-09"), "blob_delete_failed");
  });
});
