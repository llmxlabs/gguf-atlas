// Camera geometry regression checks; no browser, model reads, or dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../viewer/static/topology.js'), 'utf8'), context);
const scene = Object.create(context.window.AtlasScene.prototype);
Object.assign(scene, {yaw: .61, pitch: .62, distance: 23, target: [2, 1, -3], draw() {}});
const close = (a, b, tolerance = 1e-9) => {
  assert.equal(a.length, b.length);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < tolerance, `${i}: ${value} != ${b[i]}`));
};
const initial = scene.matrix(1.6);
scene.orbit(2 * Math.PI, 2 * Math.PI);
close(scene.matrix(1.6), initial);
scene.orbit(0, -1.4);
assert.ok(scene.pitch < 0, 'Camera must reach below the weight plane');
for (const pole of [-3 * Math.PI / 2, -Math.PI / 2, Math.PI / 2, 3 * Math.PI / 2]) {
  scene.pitch = pole - 1e-7;
  const before = scene.matrix(1.6);
  scene.pitch = pole;
  assert.ok(scene.matrix(1.6).every(Number.isFinite), 'Pole matrix must be finite');
  scene.pitch = pole + 1e-7;
  close(before, scene.matrix(1.6), 1e-5);
}
for (let i = 0; i <= 360; i++) {
  scene.pitch = i * Math.PI / 180;
  scene.yaw = -i * Math.PI / 180;
  const m = scene.matrix(1.6);
  assert.ok(m.every(Number.isFinite));
  const p = [...scene.target, 1];
  const projected = Array.from({length: 4}, (_, row) => p.reduce((sum, v, col) => sum + m[col * 4 + row] * v, 0));
  assert.ok(Math.abs(projected[0] / projected[3]) < 1e-12);
  assert.ok(Math.abs(projected[1] / projected[3]) < 1e-12);
  assert.ok(projected[3] > 0, 'Orbit target must remain in front of the camera');
}
scene.reset();
close(scene.matrix(1.6), initial);
console.log('PASS: unrestricted orbit, full-turn equivalence, continuous poles, centered target at 361 angles, reset');
