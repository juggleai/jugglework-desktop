import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

import {
  MACOS_TRAY_TEMPLATE_FILENAME,
  createPlatformTrayIconImage,
  resolveMacTrayTemplatePath,
} from "./tray-icon.mjs";

describe("tray icon image", () => {
  it("prefers the packaged macOS template resource", () => {
    const packaged = path.join("/bundle", "tray", MACOS_TRAY_TEMPLATE_FILENAME);
    const source = path.resolve("/repo/electron", "../resources/tray", MACOS_TRAY_TEMPLATE_FILENAME);
    assert.equal(resolveMacTrayTemplatePath({
      resourcesPath: "/bundle",
      moduleDirectory: "/repo/electron",
      exists: (candidate) => candidate === packaged || candidate === source,
    }), packaged);
  });

  it("falls back to the source resource for development", () => {
    const source = path.resolve("/repo/electron", "../resources/tray", MACOS_TRAY_TEMPLATE_FILENAME);
    assert.equal(resolveMacTrayTemplatePath({
      resourcesPath: "/missing",
      moduleDirectory: "/repo/electron",
      exists: (candidate) => candidate === source,
    }), source);
  });

  it("marks the macOS image as a Template Image", () => {
    let template = false;
    let loadedPath = null;
    const image = {
      isEmpty: () => false,
      setTemplateImage(value) { template = value; },
    };
    const result = createPlatformTrayIconImage({
      platform: "darwin",
      nativeImage: {
        createFromPath(candidate) {
          loadedPath = candidate;
          return image;
        },
      },
      resourcesPath: "/bundle",
      moduleDirectory: "/repo/electron",
      exists: () => true,
    });
    assert.equal(result, image);
    assert.equal(loadedPath, path.join("/bundle", "tray", MACOS_TRAY_TEMPLATE_FILENAME));
    assert.equal(template, true);
  });

  it("fails closed when the macOS resource is missing or empty", () => {
    const nativeImage = { createFromPath: () => ({ isEmpty: () => true, setTemplateImage() {} }) };
    assert.equal(createPlatformTrayIconImage({
      platform: "darwin", nativeImage, resourcesPath: "/missing", moduleDirectory: "/missing", exists: () => false,
    }), null);
    assert.equal(createPlatformTrayIconImage({
      platform: "darwin", nativeImage, resourcesPath: "/bundle", moduleDirectory: "/repo", exists: () => true,
    }), null);
  });

  it("keeps the existing brand/application fallback outside macOS", () => {
    const brandImage = { kind: "brand" };
    const appImage = { kind: "app" };
    assert.equal(createPlatformTrayIconImage({ platform: "win32", nativeImage: null, brandImage, appImage }), brandImage);
    assert.equal(createPlatformTrayIconImage({ platform: "linux", nativeImage: null, appImage }), appImage);
  });
});
