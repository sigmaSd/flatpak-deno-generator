import { decodeBase64 } from "jsr:@std/encoding@^1/base64";
import { encodeHex } from "jsr:@std/encoding@^1/hex";

interface Pkg {
  module: string;
  version: string;
  name: string;
  cpu?: "x86_64" | "aarch64";
}

// NOTE: This was used to put jsr deps inside deno_dir as well, but unfortntly
// even when hashed correctly and put in the correct place, it seems deno requrie
// some metadata checks that we can't get declerativly aka without modifying the files
// thats why we workaround this by using vendor
/**
 * Converts a URL into a hashed filename suitable for the Deno cache.
 * Handles characters not allowed in filenames and uses SHA-256 hashing
 * for the path and query string.
 *
 * @param urlString The URL string to convert.
 * @returns A promise that resolves with the hashed filename path string.
 * @throws {Error} If the URL is invalid, the scheme is not supported for caching, or hashing fails.
 */
function _urlToDenoCacheFilename(urlString: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch (e) {
    throw new Error(`Invalid URL ("${urlString}"): ${e}`);
  }

  // Construct the string to be hashed (path + query)
  // Fragment is intentionally omitted, matching the Rust code's comment.
  let restStr = url.pathname;
  if (url.search) {
    restStr += url.search;
  }

  return sha256(restStr);
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  // Convert buffer to hex string
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Converts a Base64 encoded string to its hexadecimal representation
 *
 * @param base64String The Base64 encoded string.
 * @returns The hexadecimal representation of the decoded string.
 */
function base64ToHex(base64String: string): string {
  // Step 1: Base64 decode the string into a Uint8Array.
  const binaryData: Uint8Array = decodeBase64(base64String);
  // Step 2: Convert the Uint8Array (raw binary data) to a hexadecimal string.
  const hexString: string = encodeHex(binaryData);
  return hexString;
}

function splitOnce(
  str: string,
  separator: string,
  dir: "left" | "right" = "left",
) {
  const idx = dir === "left"
    ? str.indexOf(separator)
    : str.lastIndexOf(separator);
  if (idx === -1) return [str];
  return [str.slice(0, idx), str.slice(idx + separator.length)];
}

async function jsrPkgToFlatpakData(pkg: Pkg) {
  const flatpkData = [];
  const metaUrl = `https://jsr.io/${pkg.module}/meta.json`;
  const metaText = await fetch(
    metaUrl,
  ).then((r) => r.text());

  flatpkData.push({
    type: "file",
    url: metaUrl,
    sha256: await sha256(metaText),
    dest: `vendor/jsr.io/${pkg.module}`,
    "dest-filename": "meta.json",
  });

  const metaVerUrl = `https://jsr.io/${pkg.module}/${pkg.version}_meta.json`;
  const metaVerText = await fetch(
    metaVerUrl,
  ).then((r) => r.text());

  flatpkData.push({
    type: "file",
    url: metaVerUrl,
    sha256: await sha256(metaVerText),
    dest: `vendor/jsr.io/${pkg.module}`,
    "dest-filename": `${pkg.version}_meta.json`,
  });

  const metaVer = JSON.parse(metaVerText);

  for (const fileUrl of Object.keys(metaVer.moduleGraph2)) {
    const checksum = metaVer.manifest[fileUrl];
    // this mean the url exists in the module graph but not in the manifest -> this url is not needed
    if (!checksum) continue;
    const [checksumType, checksumValue] = splitOnce(checksum.checksum, "-");

    const url = `https://jsr.io/${pkg.module}/${pkg.version}${fileUrl}`;
    const [fileDir, fileName] = splitOnce(fileUrl, "/", "right");
    // deno-ignore-fmt
    const dest = `vendor/jsr.io/${pkg.module}/${pkg.version}${fileDir}`;

    flatpkData.push({
      type: "file",
      url,
      [checksumType]: checksumValue,
      dest,
      "dest-filename": fileName,
    });
  }
  return flatpkData;
}

async function npmPkgToFlatpakData(pkg: Pkg) {
  //url: https://registry.npmjs.org/@napi-rs/cli/-/cli-2.18.4.tgz
  //npmPkgs;
  const metaUrl = `https://registry.npmjs.org/${pkg.module}`;
  const metaText = await fetch(metaUrl).then(
    (r) => r.text(),
  );
  const meta = JSON.parse(metaText);

  const metaData = {
    type: "file",
    url: metaUrl,
    sha256: await sha256(metaText),
    dest: `deno_dir/npm/registry.npmjs.org/${pkg.module}`,
    "dest-filename": "registry.json",
  };

  const [checksumType, checksumValue] = splitOnce(
    meta.versions[pkg.version].dist.integrity,
    "-",
  );
  const pkgData: Record<string, unknown> = {
    type: "archive",
    "archive-type": "tar-gzip",
    url:
      `https://registry.npmjs.org/${pkg.module}/-/${pkg.name}-${pkg.version}.tgz`,
    [checksumType]: base64ToHex(checksumValue),
    dest: `deno_dir/npm/registry.npmjs.org/${pkg.module}/${pkg.version}`,
  };

  if (pkg.cpu) {
    pkgData["only-arches"] = [pkg.cpu];
  }

  return [metaData, pkgData];
}

if (import.meta.main) {
  const arg = Deno.args[0];
  if (!arg) {
    console.error("No argument provided");
    Deno.exit(1);
  }

  const lock = JSON.parse(Deno.readTextFileSync(arg));

  const jsrPkgs: Pkg[] = Object.keys(lock.jsr).map((pkg) => {
    const r = splitOnce(pkg, "@", "right");
    const name = r[0].split("/")[1];
    return { module: r[0], version: r[1], name };
  });
  jsrPkgs;
  const npmPkgs: Pkg[] = Object.entries(lock.npm)
    .filter((
      // deno-lint-ignore no-explicit-any
      [_key, val]: any,
    ) => (val.os === undefined || val.os?.at(0) === "linux"))
    // deno-lint-ignore no-explicit-any
    .map(([key, val]: any) => {
      const r = splitOnce(key, "@", "right");
      const name = r[0].includes("/") ? r[0].split("/")[1] : r[0];
      const cpu = val.cpu?.at(0);
      return {
        module: r[0],
        version: r[1],
        name,
        cpu: cpu === "x64" ? "x86_64" : cpu === "arm64" ? "aarch64" : cpu,
      };
    });
  //url: https://registry.npmjs.org/@napi-rs/cli/-/cli-2.18.4.tgz
  npmPkgs;

  const flatpakData = [
    await Promise.all(
      jsrPkgs.map((pkg) => jsrPkgToFlatpakData(pkg)),
    ).then((r) => r.flat()),
    await Promise.all(npmPkgs.map((pkg) => npmPkgToFlatpakData(pkg))).then(
      (r) => r.flat(),
    ),
  ].flat();
  // console.log(flatpakData);
  Deno.writeTextFileSync(
    "deno-sources.json",
    JSON.stringify(flatpakData, null, 2),
  );
}
