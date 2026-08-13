import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

test("health route is mounted by the application factory", () => {
  const app = createApp();
  const routes = [];
  const visitLayers = (layers) => {
    for (const layer of layers || []) {
      if (layer.route?.path) routes.push(layer.route.path);
      if (layer.handle?.stack) visitLayers(layer.handle.stack);
    }
  };

  visitLayers(app._router.stack);
  assert.ok(routes.includes("/health"));
});
