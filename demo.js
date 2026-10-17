// demo.js: the controls of index.html. The renderer itself is metaballs.js; this file only wires the panel to it.
// URL parameters, handy for links and screenshots: ?mode=normals&count=6&blend=1.4&panel=0
(function () {
  'use strict';

  var NOTES = {
    final: 'Final: three point lights, soft shadows on the floor and walls, reflections of the scene and of the light orbs.',
    normals: 'Normals: the analytic gradient of the field, -grad F, mapped to RGB.',
    depth: 'Depth: distance from the camera to the first surface (white = near).',
    steps: 'Steps: raymarch iterations per pixel (blue = few, amber = many, budget 112).',
    field: 'Field: log2(F / threshold) on a slice through the centre, facing you. Amber is the surface, dots are the ball centres.'
  };

  var url = new URLSearchParams(location.search);
  var P = Metaballs.PARAMS;
  var initial = {};
  Object.keys(P).forEach(function (k) {
    if (!url.has(k)) return;
    initial[k] = P[k].type === 'bool' ? url.get(k) !== '0' : Number(url.get(k));
  });

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('view');
  var mb = Metaballs.create(canvas, {
    params: initial,
    mode: url.get('mode'),
    onStats: showStats
  });
  if (!mb) {
    document.body.innerHTML = '<p class="fallback">This browser has no WebGL 2, so the metaballs cannot run here.</p>';
    return;
  }
  // Folded on phones (the render first), open on wider screens; ?panel=0 or ?panel=1 forces it.
  var narrow = window.matchMedia('(max-width: 600px)').matches;
  $('panel').open = url.has('panel') ? url.get('panel') !== '0' : !narrow;

  // ---------- X-ray modes ----------
  var modeButtons = Metaballs.MODES.map(function (m) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = m.charAt(0).toUpperCase() + m.slice(1);
    b.addEventListener('click', function () { setMode(m); });
    $('modes').appendChild(b);
    return b;
  });
  function setMode(m) {
    mb.setMode(m);
    modeButtons.forEach(function (b, i) { b.setAttribute('aria-pressed', String(Metaballs.MODES[i] === m)); });
    $('note').textContent = NOTES[m];
  }
  setMode(mb.mode);
  window.addEventListener('keydown', function (e) {
    if (e.target instanceof HTMLInputElement) return;
    var i = '12345'.indexOf(e.key);
    if (i >= 0) setMode(Metaballs.MODES[i]);
  });

  // ---------- Parameters: one control per entry of Metaballs.PARAMS ----------
  var inputs = {};
  Object.keys(P).forEach(function (k) {
    var def = P[k], id = 'p-' + k, el;
    if (k === 'seed') return;               // the seed has its own button
    if (def.type === 'bool') {
      el = document.createElement('label');
      el.className = 'check';
      el.innerHTML = '<input type="checkbox" id="' + id + '"> ' + def.label;
      $('params').appendChild(el);
      inputs[k] = el.querySelector('input');
      inputs[k].addEventListener('change', function () { mb.set(pair(k, inputs[k].checked)); });
    } else {
      el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = '<label for="' + id + '">' + def.label + '</label>' +
        '<input type="range" id="' + id + '" min="' + def.min + '" max="' + def.max + '" step="' + def.step + '">' +
        '<output for="' + id + '"></output>';
      $('params').appendChild(el);
      inputs[k] = el.querySelector('input');
      inputs[k].addEventListener('input', function () { mb.set(pair(k, inputs[k].value)); show(k); });
    }
  });
  function pair(k, v) { var o = {}; o[k] = v; return o; }
  function show(k) {
    var input = inputs[k];
    if (!input) return;
    if (input.type === 'checkbox') { input.checked = !!mb.params[k]; return; }
    input.value = mb.params[k];
    input.nextElementSibling.textContent = P[k].step >= 1 ? String(mb.params[k]) : Number(mb.params[k]).toFixed(2);
  }
  function showAll() { Object.keys(inputs).forEach(show); }
  showAll();

  $('shuffle').addEventListener('click', function () { mb.set({ seed: 1 + Math.floor(Math.random() * 9998) }); });
  $('reset').addEventListener('click', function () {
    var d = {};
    Object.keys(P).forEach(function (k) { d[k] = P[k].value; });
    mb.set(d);
    mb.resetView();
    showAll();
  });

  // ---------- Frame stats ----------
  function showStats(s) {
    $('backend').textContent = s.backend;
    $('ms').textContent = s.gpuMs != null ? 'GPU ' + s.gpuMs.toFixed(2) + ' ms' :
      s.frameMs != null ? s.frameMs.toFixed(1) + ' ms per frame' : '–';
    $('res').textContent = s.width + ' x ' + s.height + ' (' + s.pixelRatio.toFixed(2) + ' px ratio)';
  }
  showStats(mb.stats);
})();
