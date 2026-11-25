'use strict';

const $ = id => document.getElementById(id);
const context = new AudioContext({sampleRate: 44100});
const rate = context.sampleRate;
const tracks = [];
const colors = ['#bc96ff', '#63dec6', '#ffb485', '#8aaeff'];
let selected, activePoint, clipboard, position = 0, pixels = 62, playback;
const seconds = clip => (clip.end - clip.begin) / clip.buffer.sampleRate;
const duration = () => Math.max(0, ...tracks.flatMap(track => track.clips.map(clip => clip.at + seconds(clip) + (clip.effect === 'echo' ? .36 : 0))));
const say = message => { $('status').textContent = message; };
const format = value => {
  const centis = Math.floor(Math.max(0, value) * 100);
  const pad = number => String(number).padStart(2, '0');
  return pad(Math.floor(centis / 6000)) + ':' + pad(Math.floor(centis / 100) % 60) + '.' + pad(centis % 100);
};

function createTrack(name) {
  const track = {name, color: colors[tracks.length % colors.length], mute: false, clips: []};
  tracks.push(track);
  return track;
}

function addTrack(name, buffer, at = 0) {
  const track = createTrack(name);
  const clip = {name, buffer, at, begin: 0, end: buffer.length, gain: 1, pan: 0, fade: 0, effect: 'none', points: [], track};
  track.clips.push(clip);
  return clip;
}

function cloneClip(clip) {
  return {...clip, points: clip.points.map(point => ({...point}))};
}

function copyClip(cut) {
  if (!selected) return;
  clipboard = cloneClip(selected);
  if (cut) removeClip();
  else inspector();
  say(cut ? 'Клип вырезан' : 'Клип скопирован');
}

function pasteClip() {
  if (!clipboard) return;
  pause();
  let track = selected?.track ?? clipboard.track;
  const end = position + seconds(clipboard);
  if (!tracks.includes(track) || track.clips.some(clip => clip.at < end && clip.at + seconds(clip) > position)) {
    track = createTrack(clipboard.name);
  }
  selected = {...cloneClip(clipboard), at: position, track};
  track.clips.push(selected);
  render();
  say('Клип вставлен в позицию ' + format(position));
}

function envelopeValue(points, frame) {
  if (!points.length) return 1;
  const index = points.findIndex(point => point.frame >= frame);
  if (index === -1) return points.at(-1).level;
  if (index === 0) return points[0].level;
  const right = points[index];
  const left = points[index - 1];
  let fraction = (frame - left.frame) / (right.frame - left.frame);
  if (right.smooth) fraction = fraction * fraction * (3 - 2 * fraction);
  return left.level + (right.level - left.level) * fraction;
}

function scheduleEnvelope(param, clip, from, start) {
  const {points, end} = clip;
  if (!points.length) return;
  const sampleRate = clip.buffer.sampleRate;
  param.setValueAtTime(envelopeValue(points, from), start);
  const rampTo = frame => param.linearRampToValueAtTime(envelopeValue(points, frame), start + (frame - from) / sampleRate);
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (point.frame <= from) continue;
    const previous = points[index - 1];
    // Use fixed subdivisions so seeking and trimming use the same curve.
    if (point.smooth && previous) {
      for (let step = 1; step < 32; step++) {
        const frame = previous.frame + (point.frame - previous.frame) * step / 32;
        if (frame > from && frame < end) rampTo(frame);
      }
    }
    if (point.frame >= end) break;
    rampTo(point.frame);
  }
  rampTo(end);
}

function cursorFrame() {
  if (!selected || position < selected.at || position > selected.at + seconds(selected)) return undefined;
  return Math.min(selected.end, selected.begin + Math.round((position - selected.at) * selected.buffer.sampleRate));
}

function pointIsVisible(clip, point) {
  return !!point && point.frame >= clip.begin && point.frame <= clip.end;
}

function pointToRemove() {
  if (selected && pointIsVisible(selected, activePoint)) return activePoint;
  const frame = cursorFrame();
  if (frame === undefined) return undefined;
  const visible = selected.points.filter(point => pointIsVisible(selected, point));
  return visible.reduce((nearest, point) => {
    if (!nearest || Math.abs(point.frame - frame) < Math.abs(nearest.frame - frame)) return point;
    return nearest;
  }, undefined);
}

function addPoint(smooth) {
  pause();
  const frame = cursorFrame();
  if (frame === undefined) return;
  activePoint = selected.points.find(point => point.frame === frame);
  if (activePoint) activePoint.smooth = smooth;
  else {
    activePoint = {frame, level: envelopeValue(selected.points, frame), smooth};
    selected.points.push(activePoint);
    selected.points.sort((left, right) => left.frame - right.frame);
  }
  render();
  say(smooth ? 'Плавная точка добавлена' : 'Точка громкости добавлена');
}

function removePoint() {
  const point = pointToRemove();
  if (!point) return;
  pause();
  selected.points.splice(selected.points.indexOf(point), 1);
  activePoint = undefined;
  render();
  say('Точка громкости удалена');
}

function selectClip(clip, button) {
  if (selected !== clip) activePoint = undefined;
  selected = clip;
  $('grid').querySelector('.selected')?.classList.remove('selected');
  button.classList.add('selected');
  inspector();
  updateCursor();
}

function showPointSelection() {
  $('automationSettings').hidden = !activePoint;
  if (activePoint) {
    $('pointLevel').value = Math.round(activePoint.level * 100);
    $('pointMode').value = activePoint.smooth ? 'smooth' : 'linear';
  }
  $('grid').querySelectorAll('.point[aria-pressed=true]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  $('grid').querySelector('.selected + .envelope + .points')
    ?.querySelector('[data-frame="' + activePoint?.frame + '"]')?.setAttribute('aria-pressed', 'true');
}

function drawEnvelope(wrapper, clip, width) {
  if (!clip.points.length) return;
  const canvas = make('canvas', 'envelope');
  canvas.width = Math.max(1, Math.min(1800, Math.ceil(width)));
  canvas.height = 42;
  const paint = canvas.getContext('2d');
  const offset = value => 3 + (1 - value) * 36;
  paint.strokeStyle = '#f0deff';
  paint.beginPath();
  for (let x = 0; x <= canvas.width; x++) {
    const frame = clip.begin + (clip.end - clip.begin) * x / canvas.width;
    paint.lineTo(x, offset(envelopeValue(clip.points, frame)));
  }
  paint.stroke();
  const points = make('div', 'points');
  for (const point of clip.points) {
    if (!pointIsVisible(clip, point)) continue;
    const marker = make('button', point.smooth ? 'point smooth' : 'point');
    marker.dataset.frame = point.frame;
    marker.style.left = (point.frame - clip.begin) / (clip.end - clip.begin) * 100 + '%';
    marker.style.top = 24 + offset(point.level) + 'px';
    marker.title = (point.smooth ? 'Плавная точка' : 'Точка') + ' · ' + Math.round(point.level * 100) + '%';
    marker.setAttribute('aria-label', marker.title + ' · ' + format(clip.at + (point.frame - clip.begin) / clip.buffer.sampleRate));
    marker.setAttribute('aria-pressed', point === activePoint && clip === selected);
    marker.onclick = () => {
      selectClip(clip, wrapper.firstElementChild);
      activePoint = point;
      showPointSelection();
      seek(clip.at + (point.frame - clip.begin) / clip.buffer.sampleRate, true);
    };
    points.append(marker);
  }
  wrapper.append(canvas, points);
}

$('copy').onclick = () => copyClip(false);
$('cut').onclick = () => copyClip(true);
$('paste').onclick = pasteClip;
$('pointAdd').onclick = () => addPoint(false);
$('pointSmooth').onclick = () => addPoint(true);
$('pointRemove').onclick = removePoint;
$('pointLevel').onchange = () => {
  if (!activePoint) return;
  pause();
  const level = $('pointLevel').valueAsNumber;
  if (Number.isFinite(level)) activePoint.level = Math.max(0, Math.min(100, level)) / 100;
  render();
};
$('pointMode').onchange = () => {
  if (!activePoint) return;
  pause();
  activePoint.smooth = $('pointMode').value === 'smooth';
  render();
};

function demo() {
  let seed = 4;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const synth = (length, sample) => {
    const buffer = context.createBuffer(1, Math.round(rate * length), rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = sample(i / rate);
    return buffer;
  };
  const sine = (frequency, time) => Math.sin(2 * Math.PI * frequency * time);
  const beat = synth(8, t => {
    const kick = t % .5;
    const hat = (t + .13) % .25;
    return .67 * sine(49, kick) * Math.exp(-kick * 23) + .18 * noise() * Math.exp(-hat * 49);
  });
  const keys = synth(7, t => {
    const note = [130.81, 196, 261.63, 311.13, 116.54, 174.61, 233.08, 293.66][Math.floor(t * 4) % 8];
    const phase = t % .25;
    const envelope = Math.min(1, phase * 170) * Math.exp(-phase * 12);
    return .31 * (sine(note, phase) + .32 * sine(note * 2, phase)) * envelope;
  });
  const fx = synth(2.65, t => .47 * sine(105 + 34 * t, t) * Math.sin(Math.PI * t / 2.65) ** 2 + .14 * noise() * Math.sin(Math.PI * t / 2.65) ** 3);
  selected = addTrack('Ночной бит', beat);
  addTrack('Мелодия', keys, .5);
  addTrack('Переход', fx, 4.25).effect = 'echo';
}

function schedule(audio, output, from, when) {
  const sources = [];
  for (const track of tracks) {
    if (track.mute) continue;
    for (const clip of track.clips) {
      const length = seconds(clip);
      const elapsed = Math.max(0, from - clip.at);
      if (elapsed >= length) continue;
      const start = when + Math.max(0, clip.at - from);
      const source = audio.createBufferSource();
      source.buffer = clip.buffer;
      const gain = audio.createGain();
      const pan = audio.createStereoPanner();
      pan.pan.value = clip.pan;
      const fade = Math.min(length, clip.fade);
      const fadeStart = length - fade;
      const initial = fade && elapsed > fadeStart ? clip.gain * (length - elapsed) / fade : clip.gain;
      gain.gain.setValueAtTime(initial, start);
      if (fade) {
        if (elapsed < fadeStart) gain.gain.setValueAtTime(clip.gain, start + fadeStart - elapsed);
        gain.gain.linearRampToValueAtTime(0, start + length - elapsed);
      }
      const envelope = audio.createGain();
      scheduleEnvelope(envelope.gain, clip, clip.begin + elapsed * clip.buffer.sampleRate, start);
      source.connect(gain).connect(envelope).connect(pan);
      if (clip.effect === 'lowpass') {
        const filter = audio.createBiquadFilter();
        filter.frequency.value = 700;
        pan.connect(filter).connect(output);
      } else {
        pan.connect(output);
        if (clip.effect === 'echo') {
          for (const [delay, level] of [[.18, .35], [.36, .16]]) {
            const tap = audio.createDelay();
            const wet = audio.createGain();
            tap.delayTime.value = delay;
            wet.gain.value = level;
            pan.connect(tap).connect(wet).connect(output);
          }
        }
      }
      source.start(start, clip.begin / clip.buffer.sampleRate + elapsed, length - elapsed);
      sources.push(source);
    }
  }
  return sources;
}

function pause() {
  if (!playback) return;
  position = Math.min(duration(), playback.from + Math.max(0, context.currentTime - playback.when));
  playback.bus.disconnect();
  playback.sources.forEach(source => source.stop());
  playback = undefined;
  updateCursor();
}

async function toggle() {
  document.dispatchEvent(new Event('stop-pattern-preview'));
  if (playback) { pause(); return; }
  if (!tracks.length) return;
  try {
    await context.resume();
    if (playback) return;
    if (position >= duration()) position = 0;
    const when = context.currentTime + .025;
    const bus = context.createGain();
    bus.connect(context.destination);
    playback = {when, bus, from: position, sources: schedule(context, bus, position, when)};
    requestAnimationFrame(tick);
  } catch { say('Не удалось запустить воспроизведение'); }
}

function tick() {
  if (!playback) return;
  position = playback.from + Math.max(0, context.currentTime - playback.when);
  if (position >= duration()) { pause(); return; }
  updateCursor();
  requestAnimationFrame(tick);
}

function seek(value, keepPoint = false) {
  const wasPlaying = !!playback;
  pause();
  position = Math.max(0, value);
  if (!keepPoint && activePoint) { activePoint = undefined; showPointSelection(); }
  updateCursor();
  if (wasPlaying) toggle();
}

function updateCursor() {
  const cursor = document.querySelector('.cursor');
  if (cursor) cursor.style.left = (document.querySelector('.track-head').offsetWidth + position * pixels) + 'px';
  $('time').textContent = format(position);
  $('play').textContent = playback ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', playback ? 'Пауза' : 'Воспроизвести');
  $('split').disabled = !selected || position <= selected.at || position >= selected.at + seconds(selected);
  $('pointAdd').disabled = $('pointSmooth').disabled = cursorFrame() === undefined;
  $('pointRemove').disabled = !pointToRemove();
}

function waveform(canvas, clip, width) {
  canvas.width = Math.max(1, Math.min(1800, Math.ceil(width)));
  canvas.height = 42;
  const paint = canvas.getContext('2d');
  const data = clip.buffer.getChannelData(0);
  const stride = (clip.end - clip.begin) / canvas.width;
  paint.fillStyle = clip.track.color;
  for (let x = 0; x < canvas.width; x++) {
    const start = Math.min(clip.end - 1, clip.begin + Math.floor(x * stride));
    const end = Math.min(clip.end, Math.max(start + 1, clip.begin + Math.floor((x + 1) * stride)));
    let low = 0, high = 0;
    for (let i = start; i < end; i += Math.max(1, Math.floor(stride / 48))) {
      low = Math.min(low, data[i]);
      high = Math.max(high, data[i]);
    }
    paint.fillRect(x, 21 - high * 20, 1, Math.max(1, (high - low) * 20));
  }
}

function make(tag, klass, label) {
  const node = document.createElement(tag);
  if (klass) node.className = klass;
  if (label) node.textContent = label;
  return node;
}

function render() {
  const grid = $('grid');
  grid.replaceChildren();
  grid.style.setProperty('--step', pixels + 'px');
  const span = Math.max(12, Math.ceil(duration()) + 2);
  const ruler = make('div', 'row ruler');
  ruler.append(make('div', 'track-head', 'ДОРОЖКИ'));
  const scale = make('div', 'lane');
  scale.style.width = span * pixels + 'px';
  scale.onclick = event => seek((event.clientX - scale.getBoundingClientRect().left) / pixels);
  const tickStep = Math.ceil(48 / pixels);
  for (let i = 0; i < span; i += tickStep) {
    const mark = make('span', 'tick', format(i).slice(0, 5));
    mark.style.left = i * pixels + 'px';
    scale.append(mark);
  }
  ruler.append(scale);
  grid.append(ruler);
  for (const track of tracks) {
    const row = make('div', 'row');
    const head = make('div', 'track-head');
    const mute = make('button', '', 'Без звука');
    mute.setAttribute('aria-pressed', track.mute);
    mute.onclick = () => { pause(); track.mute = !track.mute; render(); };
    head.append(make('strong', '', track.name), make('small', '', track.clips.length + ' клип(а)'), mute);
    const lane = make('div', 'lane');
    lane.onclick = event => { if (event.target === lane) seek((event.clientX - lane.getBoundingClientRect().left) / pixels); };
    for (const clip of track.clips) {
      const button = make('button', 'clip' + (clip === selected ? ' selected' : ''));
      button.title = 'Выбрать или перетащить ' + clip.name;
      button.style.setProperty('--color', track.color);
      const wrapper = make('div', 'clip-wrap');
      wrapper.style.left = clip.at * pixels + 'px';
      const width = Math.max(3, seconds(clip) * pixels);
      wrapper.style.width = width + 'px';
      const canvas = make('canvas');
      button.append(make('span', '', clip.name), canvas);
      waveform(canvas, clip, width);
      button.onclick = event => {
        selectClip(clip, button);
        if (event.detail) {
          const offset = (event.clientX - wrapper.getBoundingClientRect().left) / pixels;
          seek(clip.at + Math.max(0, Math.min(seconds(clip), offset)));
        }
      };
      button.onpointerdown = event => {
        if (event.button !== 0) return;
        const x = event.clientX;
        const original = clip.at;
        let moved = false;
        button.setPointerCapture(event.pointerId);
        button.onpointermove = move => {
          const delta = move.clientX - x;
          if (Math.abs(delta) < 4 && !moved) return;
          if (!moved) pause();
          moved = true;
          clip.at = Math.max(0, original + delta / pixels);
          wrapper.style.left = clip.at * pixels + 'px';
        };
        button.onpointerup = () => {
          button.onpointermove = null;
          if (moved) { selected = clip; activePoint = undefined; render(); }
        };
        button.onpointercancel = () => { clip.at = original; render(); };
      };
      wrapper.append(button);
      drawEnvelope(wrapper, clip, width);
      lane.append(wrapper);
    }
    row.append(head, lane);
    grid.append(row);
  }
  grid.append(make('div', 'cursor'));
  inspector();
  updateCursor();
}

function inspector() {
  $('settings').hidden = !selected;
  $('remove').disabled = $('copy').disabled = $('cut').disabled = !selected;
  $('paste').disabled = !clipboard;
  if (!selected?.points.includes(activePoint) || !pointIsVisible(selected, activePoint)) activePoint = undefined;
  showPointSelection();
  $('clipName').textContent = selected?.name ?? 'Выберите клип';
  $('clipMeta').textContent = selected ? format(selected.at) + '  ·  ' + seconds(selected).toFixed(2) + ' сек.' : '';
  if (!selected) return;
  $('gain').value = selected.gain * 100;
  $('gainValue').textContent = Math.round(selected.gain * 100) + '%';
  $('pan').value = selected.pan * 100;
  $('panValue').textContent = Math.round(selected.pan * 100);
  $('fade').value = selected.fade;
  $('fadeValue').textContent = selected.fade.toFixed(1) + ' с';
  const sampleRate = selected.buffer.sampleRate;
  for (const [id, frame] of [['in', selected.begin], ['out', selected.end]]) {
    $(id).max = (selected.buffer.length / sampleRate).toString();
    $(id).value = +(frame / sampleRate).toFixed(3);
  }
  $('effect').value = selected.effect;
}

for (const [id, key, divisor] of [['gain', 'gain', 100], ['pan', 'pan', 100], ['fade', 'fade', 1]]) {
  $(id).oninput = () => {
    pause();
    selected[key] = Number($(id).value) / divisor;
    inspector();
  };
}
$('effect').onchange = () => { pause(); selected.effect = $('effect').value; render(); };
for (const id of ['in', 'out']) {
  $(id).onchange = () => {
    pause();
    const frame = Math.round($(id).valueAsNumber * selected.buffer.sampleRate);
    if (Number.isFinite(frame)) {
      if (id === 'in') selected.begin = Math.min(selected.end - 1, Math.max(0, frame));
      else selected.end = Math.max(selected.begin + 1, Math.min(selected.buffer.length, frame));
    }
    position = Math.min(position, duration());
    render();
  };
}

$('split').onclick = () => {
  pause();
  const clip = selected;
  const frame = clip.begin + Math.round((position - clip.at) * clip.buffer.sampleRate);
  if (frame <= clip.begin || frame >= clip.end) return;
  const right = {...cloneClip(clip), begin: frame, at: clip.at + (frame - clip.begin) / clip.buffer.sampleRate};
  clip.end = frame;
  clip.fade = 0;
  clip.track.clips.splice(clip.track.clips.indexOf(clip) + 1, 0, right);
  selected = right;
  render();
};
function removeClip() {
  if (!selected) return;
  pause();
  const track = selected.track;
  track.clips.splice(track.clips.indexOf(selected), 1);
  if (!track.clips.length) tracks.splice(tracks.indexOf(track), 1);
  selected = track.clips[0] ?? tracks.flatMap(item => item.clips)[0];
  activePoint = undefined;
  render();
}
$('remove').onclick = removeClip;

let importing = 0;
$('new').onclick = () => {
  if (tracks.length && !confirm('Создать пустой проект? Текущий монтаж будет сброшен.')) return;
  pause();
  document.dispatchEvent(new Event('stop-pattern-preview'));
  tracks.length = 0;
  selected = undefined;
  position = 0;
  $('project').textContent = 'Новый проект';
  render();
  say('Новый проект создан');
};

async function importFiles(files) {
  importing++;
  $('new').disabled = true;
  pause();
  let count = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      selected = addTrack(file.name, buffer);
      count++;
    } catch { failed++; }
  }
  importing--;
  $('new').disabled = importing > 0;
  pause();
  render();
  say('Импортировано: ' + count + (failed ? ' · Не удалось открыть: ' + failed : ''));
}
$('files').onchange = () => {
  importFiles(Array.from($('files').files));
  $('files').value = '';
};
$('import').onclick = $('browse').onclick = () => $('files').click();
$('drop').ondragover = event => { event.preventDefault(); $('drop').classList.add('active'); };
$('drop').ondragleave = () => $('drop').classList.remove('active');
$('drop').ondrop = event => {
  event.preventDefault();
  $('drop').classList.remove('active');
  importFiles(Array.from(event.dataTransfer.files));
};
$('zoom').oninput = event => { pixels = Number(event.target.value); render(); };
$('play').onclick = toggle;
$('home').onclick = () => seek(0);
$('stop').onclick = () => {
  document.dispatchEvent(new Event('stop-pattern-preview'));
  pause();
  seek(0);
};
const shortcuts = {
  KeyC: () => copyClip(false),
  KeyV: pasteClip,
  KeyX: () => copyClip(true),
  KeyQ: () => addPoint(false),
  KeyA: removePoint
};

let waitingForAlt = false;
document.addEventListener('keydown', event => {
  const editingText = event.target.closest('input,select,textarea,[contenteditable]');
  if (event.code === 'AltLeft' || event.code === 'AltRight') {
    if (!event.repeat && !editingText && !event.ctrlKey && !event.metaKey && !event.shiftKey && cursorFrame() !== undefined) {
      waitingForAlt = true;
      event.preventDefault();
    }
    return;
  }
  waitingForAlt = false;
  if (event.repeat || editingText || event.altKey || event.shiftKey) return;
  if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.target.closest('button')) {
    event.preventDefault();
    toggle();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !['KeyC', 'KeyV', 'KeyX'].includes(event.code)) return;
  if ((event.ctrlKey || event.metaKey) && window.getSelection()?.toString()) return;
  const action = shortcuts[event.code];
  if (action) {
    event.preventDefault();
    action();
  }
});

document.addEventListener('keyup', event => {
  if (event.code !== 'AltLeft' && event.code !== 'AltRight') return;
  if (!waitingForAlt) return;
  waitingForAlt = false;
  event.preventDefault();
  addPoint(true);
});

window.addEventListener('blur', () => { waitingForAlt = false; });

function wav(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const bytes = new ArrayBuffer(44 + left.length * 4);
  const view = new DataView(bytes);
  const write = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true);
  write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, left.length * 4, true);
  const pcm = value => Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
  for (let i = 0; i < left.length; i++) {
    view.setInt16(44 + i * 4, pcm(left[i]), true);
    view.setInt16(46 + i * 4, pcm(right[i]), true);
  }
  return new Blob([bytes], {type: 'audio/wav'});
}

$('export').onclick = async () => {
  if (!duration()) { say('Добавьте аудио для экспорта'); return; }
  $('export').disabled = true;
  say('Подготовка WAV…');
  try {
    const offline = new OfflineAudioContext(2, Math.ceil(duration() * rate), rate);
    schedule(offline, offline.destination, 0, 0);
    const url = URL.createObjectURL(wav(await offline.startRendering()));
    const link = make('a');
    link.href = url;
    link.download = 'MUSICINATE.wav';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    say('WAV готов');
  } catch { say('Не удалось создать WAV'); }
  finally { $('export').disabled = false; }
};

demo();
render();
