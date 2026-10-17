/*! metaballs 2.0 | MIT License | (c) 2026 Valentin Kircher Bautista | https://github.com/kircherv/metaballs */
// Raymarched metaballs in one WebGL 2 fragment shader. No dependencies, no build step.
//
// The field is the one from a 2018 C++/OpenGL particle system, generalised with a falloff exponent k:
//   F(p) = sum_i (r_i^2 / |p - c_i|^2)^k        surface: F(p) = iso
// The renderer draws one fullscreen triangle; every pixel sphere-traces F, then shades the hit with up to three
// point lights (diffuse, specular, reflections of the light orbs and of the scene), soft shadows on the floor and walls,
// and a dashed vertical axis for scale. An "X-ray" mode shows what the shader computes: normals, depth, step count, or
// a slice of the field.
//
// Usage (classic script, so it also runs from file://):
//   <canvas id="c"></canvas>
//   <script src="metaballs.js"></script>
//   <script> const mb = Metaballs.create(document.getElementById('c')); </script>
//
// Porting to C++/HLSL: everything that matters is in FRAGMENT below. The CPU side only animates the ball centres
// (updateBalls), computes a bounding sphere (updateBound) and builds the camera basis (updateCamera).

(function (root) {
  'use strict';

  var MAX_BALLS = 16;
  var MAX_STEPS = 128;
  var MODES = ['final', 'normals', 'depth', 'steps', 'field'];

  // The parameters a visitor can play with. Every one can be set with mb.set({ name: value }).
  var PARAMS = {
    count:   { min: 1,   max: MAX_BALLS, step: 1,    value: 10,   label: 'Balls' },
    radius:  { min: 0.5, max: 1.6,       step: 0.01, value: 1,    label: 'Radius' },
    iso:     { min: 0.3, max: 3,         step: 0.01, value: 1,    label: 'Threshold' },
    blend:   { min: 0.5, max: 2.5,       step: 0.01, value: 1,    label: 'Falloff' },
    speed:   { min: 0,   max: 3,         step: 0.01, value: 1,    label: 'Speed' },
    spread:  { min: 0,   max: 2,         step: 0.01, value: 1,    label: 'Motion' },
    lights:  { min: 1,   max: 3,         step: 1,    value: 3,    label: 'Lights' },
    seed:    { min: 1,   max: 9999,      step: 1,    value: 2018, label: 'Seed' },
    shadows: { type: 'bool', value: true, label: 'Shadows' },
    scene:   { type: 'bool', value: true, label: 'Floor, walls, axis' },
    orbit:   { type: 'bool', value: true, label: 'Auto-orbit' }
  };

  // ---------- Shaders ----------
  var VERTEX = [
    '#version 300 es',
    // One triangle that covers the screen: no vertex buffer, the positions come from gl_VertexID.
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAGMENT = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    '',
    '#define MAX_BALLS ' + MAX_BALLS,
    '#define MAX_STEPS ' + MAX_STEPS,
    '#define BISECT 6',
    '#define SHADOW_STEPS 28',
    '',
    'uniform vec2 uRes;',
    'uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd, uTarget;',
    'uniform vec2 uTan;                 // tan of the half field of view, x and y',
    'uniform vec4 uBalls[MAX_BALLS];    // xyz centre, w radius',
    'uniform int uCount;',
    'uniform float uIso, uBlend;        // iso value, falloff exponent k',
    'uniform float uRho, uIsoR;         // smallest radius, iso^(-1/(2k)) (both for the step size)',
    'uniform vec4 uBound;               // bounding sphere of the surface: rays outside it do not march',
    'uniform vec3 uLightPos[3];',
    'uniform vec3 uLightCol[3];         // linear colour times intensity',
    'uniform int uLights, uMode, uScene, uShadows;',
    'uniform int uHot;                  // the light under the pointer or being dragged, -1 for none',
    'out vec4 outColor;',
    '',
    'const float W = 3.2;               // floor is [-W, W]^2 at y = 0; walls at x = -W and z = -W',
    'const float H = 3.4;               // wall height',
    'const float AXIS_TOP = 3.0;        // the dashed vertical axis runs from y = 0 to here, then an arrow head',
    'const float ORB_R = 0.07;          // radius of the visible light orbs (drag one to move its light)',
    '',
    // Colours are authored in sRGB, used in linear.
    'vec3 lin(vec3 c) { return pow(c / 255.0, vec3(2.2)); }',
    '',
    // ---------- The field ----------
    '// F only, for marching.',
    'float field(vec3 p) {',
    '  float F = 0.0;',
    '  for (int i = 0; i < MAX_BALLS; i++) {',
    '    if (i >= uCount) break;',
    '    vec3 d = p - uBalls[i].xyz;',
    '    float r2 = uBalls[i].w * uBalls[i].w;',
    '    F += pow(r2 / max(dot(d, d), 1e-4), uBlend);',
    '  }',
    '  return F;',
    '}',
    '',
    '// F and its gradient. -grad F = sum 2k f_i (p - c_i) / d_i^2 points out of the surface: the normal.',
    'vec4 fieldGrad(vec3 p) {',
    '  float F = 0.0;',
    '  vec3 G = vec3(0.0);',
    '  for (int i = 0; i < MAX_BALLS; i++) {',
    '    if (i >= uCount) break;',
    '    vec3 d = p - uBalls[i].xyz;',
    '    float d2 = max(dot(d, d), 1e-4);',
    '    float f = pow(uBalls[i].w * uBalls[i].w / d2, uBlend);',
    '    F += f;',
    '    G += d * (2.0 * uBlend * f / d2);',
    '  }',
    '  return vec4(G, F);',
    '}',
    '',
    '// Distance-like step: for one ball of radius rho, F = (rho/d)^(2k), so the distance to its iso sphere is',
    '// rho * (F^(-1/2k) - iso^(-1/2k)). Exact for one ball, shorter where balls merge (the safe side).',
    'float isoDist(float F) { return uRho * (pow(max(F, 1e-6), -0.5 / uBlend) - uIsoR); }',
    '',
    'vec2 sphere(vec3 ro, vec3 rd, vec4 s) {',
    '  vec3 oc = ro - s.xyz;',
    '  float b = dot(oc, rd);',
    '  float h = b * b - dot(oc, oc) + s.w * s.w;',
    '  if (h < 0.0) return vec2(-1.0);',
    '  h = sqrt(h);',
    '  return vec2(-b - h, -b + h);',
    '}',
    '',
    '// Sphere trace, then bisect once the surface is bracketed. Returns (t of the hit or -1, steps taken).',
    'vec2 traceBlobs(vec3 ro, vec3 rd, float tMax) {',
    '  vec2 tb = sphere(ro, rd, uBound);',
    '  if (tb.y < 0.0) return vec2(-1.0, 0.0);',
    '  float t = max(tb.x, 0.0), tEnd = min(tb.y, tMax), tPrev = t, steps = 0.0;',
    '  bool hit = false;',
    '  for (int i = 0; i < MAX_STEPS; i++) {',
    '    if (t > tEnd) break;',
    '    steps += 1.0;',
    '    float F = field(ro + rd * t);',
    '    if (F >= uIso) { hit = true; break; }',
    '    tPrev = t;',
    '    // The smallest step grows with distance (about a pixel): rays that graze one ball keep enough budget',
    '    // to reach the balls behind it instead of running out of steps and showing the background.',
    '    t += clamp(0.6 * isoDist(F), max(0.004, 0.0025 * t), 0.35);',
    '  }',
    '  if (!hit) return vec2(-1.0, steps);',
    '  float lo = tPrev, hi = t;',
    '  for (int i = 0; i < BISECT; i++) {',
    '    float m = 0.5 * (lo + hi);',
    '    if (field(ro + rd * m) >= uIso) hi = m; else lo = m;',
    '  }',
    '  return vec2(0.5 * (lo + hi), steps);',
    '}',
    '',
    '// Soft shadow towards a light: 0 in shadow, 1 lit. The closest miss along the ray gives the penumbra.',
    'float softShadow(vec3 ro, vec3 rd, float tMax) {',
    '  vec2 tb = sphere(ro, rd, uBound);',
    '  if (tb.y < 0.0 || tb.x > tMax) return 1.0;',
    '  float t = max(tb.x, 0.02), tEnd = min(tb.y, tMax), res = 1.0;',
    '  for (int i = 0; i < SHADOW_STEPS; i++) {',
    '    if (t > tEnd) break;',
    '    float d = isoDist(field(ro + rd * t));',
    '    if (d <= 0.0) return 0.0;',
    '    res = min(res, 9.0 * d / t);',
    '    t += clamp(0.7 * d, 0.02, 0.3);',
    '  }',
    '  return smoothstep(0.0, 1.0, res);',
    '}',
    '',
    // ---------- The scene: floor, two walls, light orbs ----------
    '// Nearest wall or floor, seen from its front side only (orbit behind a wall and it disappears).',
    '// Returns t (1e9 if none); id: 1 floor, 2 wall x = -W, 3 wall z = -W.',
    'float tracePlanes(vec3 ro, vec3 rd, out vec3 n, out float id) {',
    '  float best = 1e9;',
    '  id = 0.0; n = vec3(0.0);',
    '  if (uScene == 0) return best;',
    '  if (rd.y < 0.0 && ro.y > 0.0) {',
    '    float t = -ro.y / rd.y; vec3 p = ro + rd * t;',
    '    if (abs(p.x) <= W && abs(p.z) <= W) { best = t; n = vec3(0, 1, 0); id = 1.0; }',
    '  }',
    '  if (rd.x < 0.0 && ro.x > -W) {',
    '    float t = (-W - ro.x) / rd.x; vec3 p = ro + rd * t;',
    '    if (t < best && p.y >= 0.0 && p.y <= H && abs(p.z) <= W) { best = t; n = vec3(1, 0, 0); id = 2.0; }',
    '  }',
    '  if (rd.z < 0.0 && ro.z > -W) {',
    '    float t = (-W - ro.z) / rd.z; vec3 p = ro + rd * t;',
    '    if (t < best && p.y >= 0.0 && p.y <= H && abs(p.x) <= W) { best = t; n = vec3(0, 0, 1); id = 3.0; }',
    '  }',
    '  return best;',
    '}',
    '',
    '// Nearest light orb: returns t (1e9 if none) and which light.',
    'float traceOrbs(vec3 ro, vec3 rd, out int which) {',
    '  float best = 1e9; which = -1;',
    '  for (int i = 0; i < 3; i++) {',
    '    if (i >= uLights) break;',
    '    vec2 s = sphere(ro, rd, vec4(uLightPos[i], ORB_R));',
    '    if (s.x > 0.0 && s.x < best) { best = s.x; which = i; }',
    '  }',
    '  return best;',
    '}',
    '',
    'vec3 background(vec2 ndc, vec3 rd) {',
    '  vec3 top = lin(vec3(12, 20, 28)), bottom = lin(vec3(4, 6, 9));',
    '  vec3 c = mix(bottom, top, smoothstep(-0.4, 0.8, rd.y));',
    '  return c * (1.0 - 0.35 * smoothstep(0.4, 1.6, length(ndc)));',
    '}',
    '',
    '// Grid lines, anti-aliased by the pixel footprint fp (world units per pixel at that point).',
    'float gridLine(vec2 q, float spacing, float fp) {',
    '  vec2 g = abs(fract(q / spacing + 0.5) - 0.5) * spacing;',
    '  float d = min(g.x, g.y);',
    '  return 1.0 - smoothstep(0.0, max(fp, 0.004) * 1.2, d);',
    '}',
    '',
    'vec3 shadePlane(vec3 p, vec3 n, float id, float fp, bool shadows) {',
    '  vec2 q = id == 1.0 ? p.xz : (id == 2.0 ? p.zy : p.xy);',
    '  vec3 alb = id == 1.0 ? lin(vec3(34, 38, 44)) : lin(vec3(28, 32, 38));',
    '  float g = max(gridLine(q, 0.5, fp) * 0.35, gridLine(q, 1.0, fp));',
    '  alb = mix(alb, lin(vec3(70, 92, 104)), g * 0.5);',
    '  if (id == 1.0 && uHot >= 0) {           // where the light under the pointer stands on the floor',
    '    float r = length(p.xz - uLightPos[uHot].xz);',
    '    alb = mix(alb, vec3(0.9), (1.0 - smoothstep(0.0, max(fp, 0.004) * 1.5, abs(r - 0.16))) * 0.8);',
    '  }',
    '  vec3 c = alb * 0.18;',
    '  for (int i = 0; i < 3; i++) {',
    '    if (i >= uLights) break;',
    '    vec3 L = uLightPos[i] - p;',
    '    float dist = length(L); L /= dist;',
    '    float ndl = max(dot(n, L), 0.0);',
    '    if (ndl <= 0.0) continue;',
    '    float sh = (shadows && uShadows == 1) ? softShadow(p + n * 0.002, L, dist) : 1.0;',
    '    c += alb * uLightCol[i] * ndl * sh * 2.6 / (1.0 + 0.09 * dist * dist);',
    '  }',
    '  return c;',
    '}',
    '',
    'vec3 shadeBlob(vec3 p, vec3 n, vec3 rd, float fp) {',
    '  vec3 base = lin(vec3(84, 174, 235));      // the 2018 colour',
    '  vec3 deep = lin(vec3(6, 56, 70));',
    '  vec3 v = -rd;',
    '  float ndv = clamp(dot(n, v), 0.0, 1.0);',
    '  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);',
    '  vec3 c = deep * 0.12;',
    '  for (int i = 0; i < 3; i++) {',
    '    if (i >= uLights) break;',
    '    vec3 L = uLightPos[i] - p;',
    '    float dist = length(L); L /= dist;',
    '    float att = 1.0 / (1.0 + 0.09 * dist * dist);',
    '    float wrap = clamp((dot(n, L) + 0.35) / 1.35, 0.0, 1.0);',
    '    float spec = pow(max(dot(n, normalize(L + v)), 0.0), 90.0);',
    '    c += uLightCol[i] * att * (mix(deep, base, wrap) * wrap * 1.4 + vec3(spec * 1.6));',
    '  }',
    '  c += lin(vec3(90, 230, 210)) * pow(1.0 - ndv, 2.0) * 0.3;   // teal rim, the glow of the 2018 look',
    '  // Reflection: the walls and floor, then the light orbs as soft glints.',
    '  vec3 r = reflect(rd, n);',
    '  vec3 env = mix(lin(vec3(10, 22, 30)), lin(vec3(40, 110, 130)), smoothstep(-0.2, 0.9, r.y));   // studio sky',
    '  vec3 pn; float pid;',
    '  float tp = tracePlanes(p + n * 0.01, r, pn, pid);',
    '  if (pid > 0.0) env = shadePlane(p + r * tp, pn, pid, fp * 4.0, false) + env * 0.3;   // a dim wall still shows the rim',
    '  for (int i = 0; i < 3; i++) {',
    '    if (i >= uLights) break;',
    '    vec3 toL = uLightPos[i] - p;',
    '    float s = dot(toL, r);',
    '    if (s <= 0.0 || s > tp) continue;',
    '    float miss = length(toL - r * s) / s;     // angular distance from the light, roughly',
    '    env += uLightCol[i] * 3.0 * smoothstep(0.05, 0.012, miss);',
    '  }',
    '  return c + env * fres;',
    '}',
    '',
    '// A dashed vertical line at (xz) from y = 0 to top, with an arrow head if head > 0. Returns its coverage of',
    '// this pixel. The axis of the scene is lineCover(.., vec2(0), AXIS_TOP, 0.26); a dragged light gets one too.',
    'float lineCover(vec3 ro, vec3 rd, float tMax, float pix, vec2 xz, float top, float head) {',
    '  ro -= vec3(xz.x, 0.0, xz.y);',
    '  // Closest points between the ray and the line x = z = 0 (after the shift).',
    '  float b = rd.y, d = dot(rd, ro), e = ro.y, den = 1.0 - b * b;',
    '  if (den < 1e-4) return 0.0;',
    '  float s = (b * e - d) / den;               // along the ray',
    '  float y = (e - b * d) / den;               // along the axis',
    '  if (s <= 0.0 || s >= tMax) return 0.0;',
    '  float dist = length(ro + rd * s - vec3(0.0, y, 0.0));',
    '  float w = s * pix * 0.9;                   // about one pixel wide at any distance',
    '  if (y < 0.0 || y > top + head) return 0.0;',
    '  if (y > top) {',
    '    float rad = 0.075 * (top + head - y) / head;',
    '    return 1.0 - smoothstep(rad, rad + w, dist);',
    '  }',
    '  float dash = step(fract(y * 4.0), 0.55);',
    '  return dash * (1.0 - smoothstep(w * 0.5, w * 1.5, dist));',
    '}',
    '',
    '// ACES filmic curve (Narkowicz fit), then sRGB.',
    'vec3 tonemap(vec3 c) {',
    '  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);',
    '  return pow(c, vec3(1.0 / 2.2));',
    '}',
    '',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    '',
    'void main() {',
    '  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;',
    '  vec3 ro = uCamPos;',
    '  vec3 rd = normalize(uCamFwd + uCamRight * ndc.x * uTan.x + uCamUp * ndc.y * uTan.y);',
    '  float pix = 2.0 * uTan.y / uRes.y;       // radians per pixel',
    '  vec3 bg = background(ndc, rd);',
    '  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;',
    '',
    '  // X-ray "field": log2(F / iso) on the plane through the target that faces the camera.',
    '  if (uMode == 4) {',
    '    float t = dot(uTarget - ro, uCamFwd) / dot(rd, uCamFwd);',
    '    vec3 p = ro + rd * t;',
    '    float L = log2(max(field(p), 1e-6) / uIso);',
    '    float fw = max(fwidth(L), 1e-4);',
    '    float f2 = fract(L * 2.0);',
    '    float lines = 1.0 - smoothstep(0.0, fw * 3.0, min(f2, 1.0 - f2));',
    '    float iso = 1.0 - smoothstep(fw, fw * 3.0, abs(L));',
    '    vec3 col = mix(lin(vec3(6, 14, 20)), lin(vec3(18, 58, 74)), smoothstep(-2.0, 1.0, L));',
    '    col += lin(vec3(90, 230, 210)) * lines * 0.25 + lin(vec3(255, 160, 70)) * iso;',
    '    for (int i = 0; i < MAX_BALLS; i++) {   // ball centres, projected onto the slice',
    '      if (i >= uCount) break;',
    '      vec3 c = uBalls[i].xyz;',
    '      vec3 q = c - uCamFwd * dot(c - p, uCamFwd);',
    '      col = mix(col, vec3(0.9), 1.0 - smoothstep(t * pix * 2.0, t * pix * 3.5, length(p - q)));',
    '    }',
    '    float inside = 1.0 - smoothstep(uBound.w * 0.98, uBound.w, length(p - uBound.xyz));',
    '    outColor = vec4(tonemap(mix(bg, col, inside)) + dither, 1.0);',
    '    return;',
    '  }',
    '',
    '  vec3 pn; float pid;',
    '  float tp = tracePlanes(ro, rd, pn, pid);',
    '  vec2 hb = traceBlobs(ro, rd, tp);',
    '  int orb;',
    '  float to = traceOrbs(ro, rd, orb);',
    '  float tHit = hb.x > 0.0 ? hb.x : tp;',
    '  int kind = hb.x > 0.0 ? 1 : (pid > 0.0 ? 2 : 0);   // 0 nothing, 1 blob, 2 plane, 3 orb',
    '  if (orb >= 0 && to < tHit) { tHit = to; kind = 3; }',
    '  vec3 p = ro + rd * tHit;',
    '  vec3 n = kind == 1 ? normalize(fieldGrad(p).xyz + vec3(1e-7, 0.0, 0.0))',
    '         : kind == 2 ? pn : kind == 3 ? normalize(p - uLightPos[max(orb, 0)]) : vec3(0.0);',
    '',
    '  if (uMode == 3) {                        // steps: blue few, amber many',
    '    float heat = hb.y / float(MAX_STEPS);',
    '    vec3 cool = mix(lin(vec3(8, 20, 30)), lin(vec3(84, 174, 235)), smoothstep(0.0, 0.45, heat));',
    '    outColor = vec4(pow(mix(cool, lin(vec3(255, 160, 70)), smoothstep(0.5, 1.0, heat)), vec3(1.0 / 2.2)), 1.0);',
    '    return;',
    '  }',
    '  if (uMode == 1) {                        // normals',
    '    vec3 c = kind == 0 ? pow(bg, vec3(1.0 / 2.2)) : n * 0.5 + 0.5;',
    '    outColor = vec4(c + dither, 1.0);',
    '    return;',
    '  }',
    '  if (uMode == 2) {                        // depth: white near',
    '    float camD = length(uCamPos - uTarget);',
    '    float near = 1.0 - clamp((tHit - (camD - 2.5)) / 7.0, 0.0, 1.0);',
    '    vec3 c = kind == 0 ? pow(bg, vec3(1.0 / 2.2)) : vec3(near);',
    '    outColor = vec4(c + dither, 1.0);',
    '    return;',
    '  }',
    '',
    '  vec3 col = bg;',
    '  if (kind == 1) col = shadeBlob(p, n, rd, tHit * pix);',
    '  else if (kind == 2) col = shadePlane(p, n, pid, tHit * pix, true);',
    '  else if (kind == 3) col = uLightCol[max(orb, 0)] * 4.0 + vec3(0.5);',
    '  // Light glow: a halo around each orb that is in front of what the ray hit.',
    '  for (int i = 0; i < 3; i++) {',
    '    if (i >= uLights) break;',
    '    float s = dot(uLightPos[i] - ro, rd);',
    '    if (s <= 0.0 || (s > tHit && kind != 3)) continue;',
    '    float d = length(ro + rd * s - uLightPos[i]);',
    '    col += uLightCol[i] * 0.004 / (d * d + 0.004) * 0.5;',
    '  }',
    '  // The grab ring around each light orb (bright on the one under the pointer), and its line down to the floor.',
    '  for (int i = 0; i < 3; i++) {',
    '    if (i >= uLights) break;',
    '    float s = dot(uLightPos[i] - ro, rd);',
    '    if (s <= 0.0 || (s > tHit && kind != 3)) continue;',
    '    float d = length(ro + rd * s - uLightPos[i]);',
    '    float w = s * pix;',
    '    float ring = 1.0 - smoothstep(w * 0.6, w * 1.6, abs(d - ORB_R * 2.4));',
    '    col = mix(col, vec3(1.0), ring * (i == uHot ? 0.9 : 0.22));',
    '  }',
    '  float ax = uScene == 1 ? lineCover(ro, rd, tHit, pix, vec2(0.0), AXIS_TOP, 0.26) : 0.0;',
    '  if (uHot >= 0) ax = max(ax, lineCover(ro, rd, tHit, pix, uLightPos[uHot].xz, uLightPos[uHot].y - ORB_R * 2.6, 0.0) * 0.8);',
    '  col = mix(col, lin(vec3(200, 210, 220)) * 0.8, ax * 0.85);',
    '  outColor = vec4(tonemap(col) + dither, 1.0);',
    '}'
  ].join('\n');

  // ---------- Helpers ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function srgb(r, g, b) {
    return [Math.pow(r / 255, 2.2), Math.pow(g / 255, 2.2), Math.pow(b / 255, 2.2)];
  }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  var TAU = Math.PI * 2;
  var LOOP_PERIOD = 24;          // seconds: every frequency is a whole number of cycles per 24 s, so the motion loops
  var CENTRE = [0, 1.5, 0];      // the cluster floats above the floor, on the axis
  var FOV_Y = 38 * Math.PI / 180;
  var VIEW = { yaw: 0.62, pitch: 0.3, dist: 8.2 };

  // Key (warm), fill (cool) and rim (teal) lights, inside the corner the two walls make.
  var LIGHTS = [
    { pos: [2.4, 3.3, 2.1], col: srgb(255, 214, 170), power: 1.0 },
    { pos: [-2.3, 2.0, 2.5], col: srgb(130, 175, 255), power: 0.55 },
    { pos: [0.7, 2.7, -2.6], col: srgb(90, 230, 210), power: 0.8 }
  ];

  function makeBalls(seed) {
    var rnd = mulberry32(seed);
    var out = [];
    for (var i = 0; i < MAX_BALLS; i++) {
      var x, y, z;
      do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1);
      out.push({
        base: [x * 1.25, y * 0.7, z * 1.25],
        amp: [0.25 + rnd() * 0.2, 0.18 + rnd() * 0.16, 0.25 + rnd() * 0.2],
        k: [1 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 3)],
        ph: [rnd() * TAU, rnd() * TAU, rnd() * TAU],
        r: 0.19 + rnd() * 0.06
      });
    }
    return out;
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('metaballs: shader did not compile:\n' + log);
    }
    return s;
  }

  // ---------- create() ----------
  // options: params {name: value}, mode, interactive (true), wheelZoom (true), touchAction ('none'),
  //          maxPixelRatio (1.5), onStats(stats) about 4 times a second, autoStart (true).
  // Returns null when the browser has no WebGL 2 (show a poster instead).
  function create(canvas, options) {
    options = options || {};
    var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' });
    if (!gl) return null;

    var reduceMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var params = {};
    Object.keys(PARAMS).forEach(function (k) { params[k] = PARAMS[k].value; });
    if (reduceMotion) { params.speed = 0; params.orbit = false; }
    Object.assign(params, options.params || {});
    var mode = MODES.indexOf(options.mode) >= 0 ? options.mode : 'final';
    var maxDpr = options.maxPixelRatio || 1.5;

    var prog, loc = {};
    var timerExt = null, query = null;
    function build() {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('metaballs: ' + gl.getProgramInfoLog(prog));
      ['uRes', 'uCamPos', 'uCamRight', 'uCamUp', 'uCamFwd', 'uTarget', 'uTan', 'uBalls', 'uCount', 'uIso', 'uBlend',
        'uRho', 'uIsoR', 'uBound', 'uLightPos', 'uLightCol', 'uLights', 'uMode', 'uScene', 'uShadows', 'uHot'
      ].forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n) || gl.getUniformLocation(prog, n + '[0]'); });
      gl.bindVertexArray(gl.createVertexArray());   // gl_VertexID needs a bound (empty) VAO
      timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      query = null;
    }
    build();

    // ---------- State ----------
    var balls = makeBalls(params.seed);
    var ballData = new Float32Array(MAX_BALLS * 4);
    var bound = [0, 0, 0, 1];
    var rho = 0.3;
    var cam = { yaw: VIEW.yaw, pitch: VIEW.pitch, dist: VIEW.dist, target: CENTRE.slice() };
    var basis = { pos: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1] };
    var vel = { yaw: 0, pitch: 0 };
    var lights = LIGHTS.map(function (l) { return l.pos.slice(); });   // the visitor can drag them
    var hot = -1, dragLight = -1;
    var tanX = 1, tanY = 1;
    var time = 0, lastNow = 0, idleSince = 0;
    var running = false, raf = 0, destroyed = false, lost = false;
    var scale = 1, slowFrames = 0;
    var stats = { backend: 'WebGL 2', gpuMs: null, frameMs: null, scale: 1, pixelRatio: 1, width: 0, height: 0 };
    var lastStats = 0, frameAvg = 0;

    function updateBalls() {
      var n = clamp(params.count | 0, 1, MAX_BALLS);
      var minR = 1e9, s = params.spread, rs = params.radius;
      for (var i = 0; i < MAX_BALLS; i++) {
        var b = balls[i];
        for (var a = 0; a < 3; a++) {
          var w = TAU * b.k[a] / LOOP_PERIOD;
          ballData[i * 4 + a] = CENTRE[a] + b.base[a] + s * b.amp[a] * Math.sin(w * time + b.ph[a]);
        }
        ballData[i * 4 + 3] = b.r * rs;
        if (i < n) minR = Math.min(minR, b.r * rs);
      }
      rho = minR;
      updateBound(n);
    }

    // Bounding sphere: far from all balls F < n (r/d)^(2k), so beyond d = r (n/iso)^(1/2k) there is no surface.
    function updateBound(n) {
      var cx = 0, cy = 0, cz = 0, i;
      for (i = 0; i < n; i++) { cx += ballData[i * 4]; cy += ballData[i * 4 + 1]; cz += ballData[i * 4 + 2]; }
      cx /= n; cy /= n; cz /= n;
      var far = 0, maxR = 0;
      for (i = 0; i < n; i++) {
        var dx = ballData[i * 4] - cx, dy = ballData[i * 4 + 1] - cy, dz = ballData[i * 4 + 2] - cz;
        far = Math.max(far, Math.sqrt(dx * dx + dy * dy + dz * dz));
        maxR = Math.max(maxR, ballData[i * 4 + 3]);
      }
      var reach = maxR * Math.pow(n / params.iso, 0.5 / params.blend);
      bound = [cx, cy, cz, Math.min(far + reach + 0.02, 9)];
    }

    function updateCamera() {
      cam.pitch = clamp(cam.pitch, 0.02, 1.45);
      cam.dist = clamp(cam.dist, 3.2, 16);
      var cp = Math.cos(cam.pitch), t = cam.target;
      var pos = [t[0] + cam.dist * cp * Math.sin(cam.yaw), t[1] + cam.dist * Math.sin(cam.pitch), t[2] + cam.dist * cp * Math.cos(cam.yaw)];
      var f = [t[0] - pos[0], t[1] - pos[1], t[2] - pos[2]];
      var fl = Math.hypot(f[0], f[1], f[2]); f = [f[0] / fl, f[1] / fl, f[2] / fl];
      var r = [-f[2], 0, f[0]];                     // fwd x world up
      var rl = Math.hypot(r[0], r[2]); r = [r[0] / rl, 0, r[2] / rl];
      var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      basis.pos = pos; basis.right = r; basis.up = u; basis.fwd = f;
    }

    function resize() {
      var dpr = Math.min(root.devicePixelRatio || 1, maxDpr) * scale;
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      stats.scale = scale; stats.pixelRatio = dpr; stats.width = w; stats.height = h;
    }

    function readTimer() {
      if (!timerExt || !query) return;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) stats.gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(query);
      query = null;
    }

    function draw() {
      if (lost) return;
      resize();
      updateBalls();
      updateCamera();
      readTimer();
      var timing = timerExt && !query;
      if (timing) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); }

      var n = clamp(params.count | 0, 1, MAX_BALLS), nl = clamp(params.lights | 0, 1, 3);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.uniform2f(loc.uRes, canvas.width, canvas.height);
      gl.uniform3fv(loc.uCamPos, basis.pos);
      gl.uniform3fv(loc.uCamRight, basis.right);
      gl.uniform3fv(loc.uCamUp, basis.up);
      gl.uniform3fv(loc.uCamFwd, basis.fwd);
      gl.uniform3fv(loc.uTarget, cam.target);
      // The field of view applies to the shorter side, so a phone in portrait sees the same scene, not a crop.
      var tf = Math.tan(FOV_Y / 2), aspect = canvas.width / canvas.height;
      tanX = aspect >= 1 ? tf * aspect : tf;
      tanY = aspect >= 1 ? tf : tf / aspect;
      gl.uniform2f(loc.uTan, tanX, tanY);
      gl.uniform4fv(loc.uBalls, ballData);
      gl.uniform1i(loc.uCount, n);
      gl.uniform1f(loc.uIso, params.iso);
      gl.uniform1f(loc.uBlend, params.blend);
      gl.uniform1f(loc.uRho, rho);
      gl.uniform1f(loc.uIsoR, Math.pow(params.iso, -0.5 / params.blend));
      gl.uniform4fv(loc.uBound, bound);
      var lp = [], lc = [];
      LIGHTS.forEach(function (l, i) {
        lp.push(lights[i][0], lights[i][1], lights[i][2]);
        lc.push(l.col[0] * l.power, l.col[1] * l.power, l.col[2] * l.power);
      });
      gl.uniform3fv(loc.uLightPos, lp);
      gl.uniform3fv(loc.uLightCol, lc);
      gl.uniform1i(loc.uLights, nl);
      gl.uniform1i(loc.uMode, MODES.indexOf(mode));
      gl.uniform1i(loc.uScene, params.scene ? 1 : 0);
      gl.uniform1i(loc.uShadows, params.shadows ? 1 : 0);
      gl.uniform1i(loc.uHot, hot < nl ? hot : -1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (timing) gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    }

    // ---------- Loop: renders only while something moves ----------
    function animating(now) {
      return params.speed > 0 || dragging() || Math.abs(vel.yaw) + Math.abs(vel.pitch) > 1e-4 ||
        (params.orbit && now - idleSince > 2500);
    }

    function tick(now) {
      raf = 0;
      if (!running || destroyed) return;
      var dt = lastNow ? Math.min((now - lastNow) / 1000, 0.1) : 0;
      lastNow = now;
      time += dt * params.speed;
      if (!dragging()) {
        cam.yaw += vel.yaw; cam.pitch += vel.pitch;
        vel.yaw *= 0.9; vel.pitch *= 0.9;
        if (params.orbit && now - idleSince > 2500) cam.yaw += dt * 0.12;
      }
      draw();

      // Adapt: frames slower than ~30 fps for a second drop the resolution (1 -> 0.75 -> 0.5), never back up.
      if (dt > 0) {
        frameAvg = frameAvg ? frameAvg * 0.9 + dt * 100 : dt * 1000;
        if (dt > 0.034) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
        if (slowFrames > 30 && scale > 0.5) { scale = Math.max(0.5, scale - 0.25); slowFrames = 0; }
      }
      if (now - lastStats > 250) {
        lastStats = now;
        stats.frameMs = dt > 0 ? frameAvg : null;
        if (options.onStats) options.onStats(stats);
      }
      if (animating(now)) raf = root.requestAnimationFrame(tick);
      else lastNow = 0;
    }

    function invalidate() {
      if (running && !raf && !destroyed) raf = root.requestAnimationFrame(tick);
    }

    // ---------- Orbit camera: drag, pinch, wheel, keys, double-click to reset ----------
    var pointers = new Map();
    var pinchDist = 0;
    function dragging() { return pointers.size > 0; }
    function poke() { idleSince = performance.now(); invalidate(); }

    // ---------- Lights: grab an orb and drag it; it moves in the plane that faces the camera, inside the room ----------
    function pointerRay(e) {
      var r = canvas.getBoundingClientRect();
      var nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = 1 - ((e.clientY - r.top) / r.height) * 2;
      var b = basis, d = [0, 0, 0];
      for (var a = 0; a < 3; a++) d[a] = b.fwd[a] + b.right[a] * nx * tanX + b.up[a] * ny * tanY;
      var l = Math.hypot(d[0], d[1], d[2]);
      return [d[0] / l, d[1] / l, d[2] / l];
    }
    // The light whose orb is under the pointer (within a few pixels, more for a finger), or -1.
    function pickLight(e) {
      if (mode === 'steps' || mode === 'field') return -1;
      var r = canvas.getBoundingClientRect(), d = pointerRay(e), best = -1, bestD = 1e9;
      var slack = (e.pointerType === 'mouse' ? 10 : 24) * 2 * tanY / r.height;   // pixels, as an angle
      for (var i = 0; i < clamp(params.lights | 0, 1, 3); i++) {
        var v = [lights[i][0] - basis.pos[0], lights[i][1] - basis.pos[1], lights[i][2] - basis.pos[2]];
        var s = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
        if (s <= 0) continue;
        var miss = Math.hypot(v[0] - d[0] * s, v[1] - d[1] * s, v[2] - d[2] * s);
        if (miss < 0.07 * 2.6 + slack * s && s < bestD) { best = i; bestD = s; }
      }
      return best;
    }
    function moveLight(e) {
      var d = pointerRay(e), L = lights[dragLight], f = basis.fwd, o = basis.pos;
      var den = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      if (den < 1e-3) return;
      var t = ((L[0] - o[0]) * f[0] + (L[1] - o[1]) * f[1] + (L[2] - o[2]) * f[2]) / den;
      L[0] = clamp(o[0] + d[0] * t, -3.05, 3.05);
      L[1] = clamp(o[1] + d[1] * t, 0.25, 3.25);
      L[2] = clamp(o[2] + d[2] * t, -3.05, 3.05);
    }
    function setHot(i) {
      if (i === hot) return;
      hot = i;
      canvas.style.cursor = i >= 0 ? (dragLight >= 0 ? 'grabbing' : 'grab') : '';
      invalidate();
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      if (pointers.size === 0) {
        var i = pickLight(e);
        if (i >= 0) {
          dragLight = i;
          setHot(i);
          canvas.style.cursor = 'grabbing';
        }
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* already released */ }
      vel.yaw = vel.pitch = 0;
      if (pointers.size === 2) pinchDist = pinchLength();
      poke();
    }
    function onMove(e) {
      var p = pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') setHot(pickLight(e));   // hover: show which orb can be grabbed
        return;
      }
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (dragLight >= 0) {
        moveLight(e);
      } else if (pointers.size === 1) {
        vel.yaw = -dx * 0.006; vel.pitch = dy * 0.006;
        cam.yaw += vel.yaw; cam.pitch += vel.pitch;
      } else if (pointers.size === 2) {
        var d = pinchLength();
        if (pinchDist > 0 && d > 0) cam.dist *= pinchDist / d;
        pinchDist = d;
      }
      poke();
    }
    function onUp(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0 && dragLight >= 0) {
        dragLight = -1;
        canvas.style.cursor = '';
        setHot(e.pointerType === 'mouse' ? pickLight(e) : -1);
      }
      poke();
    }
    function resetLights() {
      lights = LIGHTS.map(function (l) { return l.pos.slice(); });
      poke();
    }
    function pinchLength() {
      var a = Array.from(pointers.values());
      return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    }
    function onWheel(e) {
      e.preventDefault();
      cam.dist *= Math.exp(clamp(e.deltaY, -100, 100) * 0.0015);
      poke();
    }
    function onKey(e) {
      var k = e.key, step = 0.08;
      if (k === 'ArrowLeft') cam.yaw += step;
      else if (k === 'ArrowRight') cam.yaw -= step;
      else if (k === 'ArrowUp') cam.pitch += step;
      else if (k === 'ArrowDown') cam.pitch -= step;
      else if (k === '+' || k === '=') cam.dist *= 0.92;
      else if (k === '-' || k === '_') cam.dist *= 1.08;
      else if (k === 'r' || k === 'R') resetView();
      else return;
      e.preventDefault();
      poke();
    }
    function resetView() {
      cam.yaw = VIEW.yaw; cam.pitch = VIEW.pitch; cam.dist = VIEW.dist;
      vel.yaw = vel.pitch = 0;
      poke();
    }

    var listeners = [];
    function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); }
    if (options.interactive !== false) {
      canvas.style.touchAction = options.touchAction || 'none';
      if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
      on(canvas, 'pointerdown', onDown);
      on(canvas, 'pointermove', onMove);
      on(canvas, 'pointerup', onUp);
      on(canvas, 'pointercancel', onUp);
      on(canvas, 'pointerleave', function () { if (dragLight < 0) setHot(-1); });
      on(canvas, 'dblclick', resetView);
      on(canvas, 'keydown', onKey);
      if (options.wheelZoom !== false) on(canvas, 'wheel', onWheel, { passive: false });
    }
    on(canvas, 'webglcontextlost', function (e) { e.preventDefault(); lost = true; });
    on(canvas, 'webglcontextrestored', function () { lost = false; build(); invalidate(); });
    var ro = root.ResizeObserver ? new root.ResizeObserver(function () { invalidate(); }) : null;
    if (ro) ro.observe(canvas);

    var api = {
      params: params,
      stats: stats,
      get mode() { return mode; },
      // Change parameters, e.g. mb.set({ count: 6, blend: 1.4 }). Unknown names are ignored.
      set: function (changes) {
        Object.keys(changes).forEach(function (k) {
          if (!(k in PARAMS)) return;
          var v = changes[k], def = PARAMS[k];
          params[k] = def.type === 'bool' ? !!v : clamp(Number(v), def.min, def.max);
          if (k === 'seed') balls = makeBalls(params.seed | 0);
        });
        poke();
        return api;
      },
      setMode: function (m) { if (MODES.indexOf(m) >= 0) { mode = m; invalidate(); } return api; },
      resetView: resetView,
      // The three light positions ([x, y, z] each), which the visitor can drag; resetLights() puts them back.
      get lights() { return lights; },
      resetLights: resetLights,
      start: function () { running = true; lastNow = 0; invalidate(); return api; },
      stop: function () { running = false; if (raf) root.cancelAnimationFrame(raf); raf = 0; lastNow = 0; return api; },
      // Draw one frame at time t (seconds) without the loop: posters, tests.
      renderAt: function (t) { time = t || 0; draw(); return api; },
      destroy: function () {
        api.stop();
        destroyed = true;
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
        if (ro) ro.disconnect();
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    };
    idleSince = performance.now();
    if (options.autoStart !== false) api.start();
    return api;
  }

  root.Metaballs = { create: create, PARAMS: PARAMS, MODES: MODES, MAX_BALLS: MAX_BALLS, FRAGMENT: FRAGMENT };
})(typeof window !== 'undefined' ? window : this);
