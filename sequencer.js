'use strict';

{
  const pageSize = 16;
  const drums = ['Бочка', 'Малый', 'Хай-хэт', 'Хлопок', 'Том', 'Шейкер', 'Тарелка'];
  const pitches = ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'];
  const patterns = {drums: new Map(), melody: new Map()};
  const pages = {drums: 0, melody: 0};
  const auditioning = new Set();
  const lowestNote = -12;
  const highestNote = 131;
  let mode = 'drums';
  let octave = 4;
  let chosen, preview, previewRequest = 0;
  let visiblePads = [];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const cellKey = (row, step) => row + ':' + step;
  const noteName = note => pitches[((note % 12) + 12) % 12] + ' ' + (Math.floor(note / 12) - 1);
  const sine = phase => Math.sin(2 * Math.PI * phase);
  const sampleCache = new Map();
  const sampleRelease = {grand: .24, piano: .19, bass: .13, pluck: .23, organ: .075, bell: .34};

  function nearestRoot(voice, note) {
    return Object.keys(instrumentSamples[voice]).map(Number).reduce((nearest, root) =>
      Math.abs(root - note) < Math.abs(nearest - note) ? root : nearest);
  }

  function loadSample(voice, root) {
    const key = voice + ':' + root;
    if (!sampleCache.has(key)) {
      const data = Uint8Array.from(atob(instrumentSamples[voice][root]), char => char.charCodeAt(0));
      const decoded = context.decodeAudioData(data.buffer).then(buffer => {
        const left = buffer.getChannelData(0);
        const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
        let peak = .01;
        for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        return {left, right, rate: buffer.sampleRate, gain: Math.min(6, .56 / peak)};
      }).catch(error => {
        sampleCache.delete(key);
        throw error;
      });
      sampleCache.set(key, decoded);
    }
    return sampleCache.get(key);
  }

  function warmVoice() {
    if (mode !== 'melody') return;
    const voice = $('voice').value;
    const start = (octave + 1) * 12;
    const roots = new Set([0, 4, 8, 11].map(semitone => nearestRoot(voice, start + semitone)));
    Promise.all([...roots].map(root => loadSample(voice, root))).catch(() => {});
  }

  function mixSample(event, voice, sample, root, left, right, start, gate) {
    const tuning = 2 ** ((event.row + event.pitch - root) / 12) * sample.rate / rate;
    const release = Math.round(sampleRelease[voice] * rate);
    const limit = Math.min(left.length - start, gate + release);
    const loopStart = Math.floor(sample.rate * .34);
    const loopEnd = Math.min(sample.left.length - 2, Math.floor(sample.rate * 1.04));
    const crossfade = Math.min(Math.floor(sample.rate * .023), Math.floor((loopEnd - loopStart) / 3));
    const loop = voice === 'organ' && crossfade > 1;
    const interpolate = (channel, at) => {
      const index = Math.floor(at);
      return channel[index] + (channel[index + 1] - channel[index]) * (at - index);
    };
    const pan = (event.row % 7 - 3) * .035;
    const velocity = event.step % 4 === 0 ? 1 : .92;
    for (let i = 0; i < limit; i++) {
      let at = i * tuning;
      if (loop && at >= loopEnd) at = loopStart + crossfade + (at - loopEnd) % (loopEnd - loopStart - crossfade);
      if (at >= sample.left.length - 1) break;
      const blend = loop ? clamp((at - loopEnd + crossfade) / crossfade, 0, 1) : 0;
      const crossAt = loopStart + (at - loopEnd + crossfade);
      const read = channel => interpolate(channel, at) * (1 - blend) + (blend ? interpolate(channel, crossAt) * blend : 0);
      const envelope = Math.min(1, i / (rate * .003)) * (1 - clamp((i - gate) / release, 0, 1)) ** 2;
      const gain = envelope * sample.gain * velocity;
      left[start + i] += read(sample.left) * gain * (1 - pan);
      right[start + i] += read(sample.right) * gain * (1 + pan);
    }
  }

  function stepSeconds() {
    const input = $('tempo');
    const bpm = Number.isFinite(input.valueAsNumber) ? Math.round(input.valueAsNumber) : Number(input.defaultValue);
    const tempo = clamp(bpm, Number(input.min), Number(input.max));
    input.value = tempo;
    return 60 / tempo / 4;
  }

  function makeDrumSampler(event) {
    let seed = (19 + event.row * 31 + event.step * 113) >>> 0;
    let previousNoise = 0;
    let coloredNoise = 0;
    const tuning = 2 ** (event.pitch / 12);
    const velocity = event.step % 4 === 0 ? 1 : .9 + (seed % 11) / 100;

    return (time, duration) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed / 2147483648 - 1;
      const high = (noise - previousNoise) * .65;
      previousNoise = noise;
      coloredNoise += .22 * (noise - coloredNoise);
      const edge = Math.min(1, time / .004, (duration - time) / Math.min(.037, duration / 2));
      let sample;
      const t = time * tuning;
      switch (event.row) {
        case 0: {
          const phase = 46 * t + 3.8 * (1 - Math.exp(-t * 36));
          sample = .74 * sine(phase) * Math.exp(-t * 13) + .16 * high * Math.exp(-t * 175);
          break;
        }
        case 1:
          sample = (.53 * high + .24 * noise) * Math.exp(-t * 27)
            + (.23 * sine(178 * t) + .10 * sine(317 * t)) * Math.exp(-t * 46);
          break;
        case 2:
          sample = (.27 * high + .10 * sine(6203 * t) * sine(8393 * t)) * Math.exp(-t * 44);
          break;
        case 3: {
          const burst = [0, .011, .023, .035].reduce((sum, offset) =>
            t >= offset ? sum + Math.exp(-(t - offset) * 103) : sum, 0);
          sample = .21 * (high + .6 * coloredNoise) * (burst + .18 * Math.exp(-t * 15));
          break;
        }
        case 4: {
          const phase = 112 * t + 1.25 * (1 - Math.exp(-t * 24));
          sample = (.48 * sine(phase) + .17 * sine(1.57 * phase) * Math.exp(-t * 12)) * Math.exp(-t * 10)
            + .12 * coloredNoise * Math.exp(-t * 115);
          break;
        }
        case 5:
          sample = .43 * high * Math.sin(Math.PI * Math.min(1, t / .18)) ** 2;
          break;
        default:
          sample = (.19 * high + .12 * sine(3697 * t) * sine(4591 * t) + .07 * sine(5119 * t)) * Math.exp(-t * 8);
      }
      return sample * edge * velocity;
    };
  }

  async function renderEvents(events, stepTime, fullPattern, voice) {
    const tail = events.reduce((end, event) => Math.max(end, event.step + event.length), 0);
    const steps = fullPattern ? Math.ceil(tail / 4) * 4 : tail;
    const isMelody = events[0]?.kind === 'melody';
    const musicSeconds = isMelody ? Math.max(steps * stepTime, tail * stepTime + sampleRelease[voice]) : steps * stepTime;
    const frameCount = Math.max(1, Math.ceil(musicSeconds * rate));
    // Avoid attempting a huge synchronous audio allocation from a mistyped step number.
    if (frameCount * 8 > 128 * 1024 * 1024) throw new RangeError('Pattern exceeds audio buffer budget');
    const roots = isMelody ? events.map(event => nearestRoot(voice, event.row + event.pitch)) : [];
    const samples = await Promise.all(roots.map(root => loadSample(voice, root)));
    const buffer = context.createBuffer(2, frameCount, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const reflection = Math.round(.019 * rate);
    for (const [index, event] of events.entries()) {
      const start = Math.round(event.step * stepTime * rate);
      const length = Math.min(frameCount - start, Math.ceil(event.length * stepTime * rate));
      if (isMelody) {
        mixSample(event, voice, samples[index], roots[index], left, right, start, length);
        continue;
      }
      const sample = makeDrumSampler(event);
      const pan = [0, 0, .22, -.13, -.22, .33, -.32][event.row];
      const volumeL = Math.sqrt(.5 - .5 * pan);
      const volumeR = Math.sqrt(.5 + .5 * pan);
      for (let i = 0; i < length; i++) {
        const value = sample(i / rate, length / rate);
        left[start + i] += value * volumeL;
        right[start + i] += value * volumeR;
        if (i + reflection < length) right[start + i + reflection] += value * .062;
      }
    }
    let peak = .96;
    for (let frame = 0; frame < frameCount; frame++) peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
    if (peak > .96) {
      const scale = .96 / peak;
      for (let frame = 0; frame < frameCount; frame++) {
        left[frame] *= scale;
        right[frame] *= scale;
      }
    }
    return buffer;
  }

  function stopAudio() {
    previewRequest++;
    for (const source of auditioning) source.stop();
    auditioning.clear();
    if (!preview) return;
    preview.stop();
    preview = undefined;
    updateControls();
  }

  async function audition(event) {
    const request = previewRequest;
    const note = {...event, step: 0, length: Math.min(event.length, 8)};
    const voice = $('voice').value;
    const stepTime = stepSeconds();
    if (note.kind === 'melody') note.length = Math.max(note.length, .22 / stepTime);
    try {
      const [, buffer] = await Promise.all([context.resume(), renderEvents([note], stepTime, false, voice)]);
      if (request !== previewRequest) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => auditioning.delete(source);
      auditioning.add(source);
      source.start();
    } catch { say('Не удалось прослушать звук'); }
  }

  function updateControls() {
    const hasEvents = patterns[mode].size > 0;
    $('patternClear').disabled = !hasEvents;
    $('patternInsert').disabled = !hasEvents;
    $('patternPreview').disabled = !hasEvents && !preview;
    $('patternPreview').textContent = preview ? '■ Остановить' : '▶ Прослушать';
    $('eventControls').hidden = !chosen;
    if (!chosen) return;
    const isMelody = chosen.kind === 'melody';
    const name = isMelody ? noteName(chosen.row + chosen.pitch) : drums[chosen.row];
    $('eventName').textContent = name + ' · шаг ' + (chosen.step + 1);
    $('eventPitch').min = isMelody ? lowestNote - chosen.row : -48;
    $('eventPitch').max = isMelody ? highestNote - chosen.row : 48;
    $('eventPitch').value = chosen.pitch;
    $('eventLength').value = chosen.length;
  }

  function refreshPads() {
    const events = patterns[mode];
    const rowEvents = new Map();
    for (const event of events.values()) {
      if (!rowEvents.has(event.row)) rowEvents.set(event.row, []);
      rowEvents.get(event.row).push(event);
    }
    for (const {pad, row, step, key, label} of visiblePads) {
      const event = events.get(key);
      const sustained = !event && rowEvents.get(row)?.some(item => item.step < step && item.step + item.length > step);
      pad.classList.toggle('chosen', !!event && event === chosen);
      pad.classList.toggle('sustained', !!sustained);
      pad.setAttribute('aria-label', (event && mode === 'melody' ? noteName(row + event.pitch) : label) + ', шаг ' + (step + 1));
      pad.setAttribute('aria-pressed', !!event);
    }
    updateControls();
  }

  function drawPattern(focusKey) {
    const grid = $('patternGrid');
    const offset = pages[mode];
    const isMelody = mode === 'melody';
    const octaveStart = (octave + 1) * 12;
    const rows = isMelody ? pitches.map((_, i) => octaveStart + 11 - i) : drums.map((_, i) => i);
    const events = patterns[mode];
    grid.dataset.mode = mode;
    grid.replaceChildren(make('span'));
    visiblePads = [];
    $('voiceLabel').hidden = $('octaveLabel').hidden = !isMelody;
    $('firstStep').value = offset + 1;
    $('octave').value = octave;
    $('priorSteps').disabled = offset === 0;
    for (let column = 0; column < pageSize; column++) {
      grid.append(make('span', 'step-number', String(offset + column + 1)));
    }
    for (const row of rows) {
      const label = isMelody ? noteName(row) : drums[row];
      grid.append(make('span', 'pattern-name', label));
      for (let column = 0; column < pageSize; column++) {
        const step = offset + column;
        const key = cellKey(row, step);
        const pad = make('button', 'step-pad');
        pad.classList.toggle('group-start', step % 4 === 0);
        visiblePads.push({pad, row, step, key, label});
        pad.onclick = () => {
          if (preview) stopAudio();
          chosen = events.get(key) ?? {kind: mode, row, step, pitch: 0, length: 1};
          events.set(key, chosen);
          refreshPads();
          audition(chosen);
        };
        const remove = () => {
          const event = events.get(key);
          if (!event) return;
          stopAudio();
          events.delete(key);
          if (chosen === event) chosen = undefined;
          refreshPads();
        };
        pad.oncontextmenu = event => {
          event.preventDefault();
          remove();
        };
        pad.onkeydown = event => {
          if (event.code !== 'Delete' && event.code !== 'Backspace') return;
          event.preventDefault();
          remove();
        };
        grid.append(pad);
        if (key === focusKey) pad.focus({preventScroll: true});
      }
    }
    $('drumsTab').setAttribute('aria-pressed', !isMelody);
    $('melodyTab').setAttribute('aria-pressed', isMelody);
    refreshPads();
  }

  function jump(step) {
    pages[mode] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - pageSize, Math.round(step)));
    drawPattern();
  }

  $('priorSteps').onclick = () => jump(pages[mode] - pageSize);
  $('nextSteps').onclick = () => jump(pages[mode] + pageSize);
  $('firstStep').onchange = () => jump(($('firstStep').valueAsNumber || 1) - 1);
  $('octave').onchange = () => {
    octave = clamp(Math.round($('octave').valueAsNumber || 0), -2, 9);
    drawPattern();
    warmVoice();
  };
  $('eventPitch').onchange = () => {
    if (!chosen) return;
    const input = $('eventPitch');
    if (Number.isFinite(input.valueAsNumber)) chosen.pitch = clamp(Math.round(input.valueAsNumber), +input.min, +input.max);
    if (preview) stopAudio();
    refreshPads();
    audition(chosen);
  };
  $('eventLength').onchange = () => {
    if (!chosen) return;
    const length = $('eventLength').valueAsNumber;
    if (Number.isFinite(length)) chosen.length = Math.max(.125, length);
    if (preview) stopAudio();
    refreshPads();
  };
  $('eventListen').onclick = () => { if (chosen) audition(chosen); };
  $('eventRemove').onclick = () => {
    if (!chosen) return;
    stopAudio();
    const key = cellKey(chosen.row, chosen.step);
    patterns[chosen.kind].delete(key);
    chosen = undefined;
    drawPattern(key);
  };

  $('sequencerToggle').onclick = () => {
    const open = $('sequencer').hidden;
    $('sequencer').hidden = !open;
    $('sequencerToggle').setAttribute('aria-expanded', open);
    if (!open) stopAudio();
    else $('sequencer').scrollIntoView({block: 'nearest'});
  };
  for (const [id, type] of [['drumsTab', 'drums'], ['melodyTab', 'melody']]) {
    $(id).onclick = () => {
      if (mode === type) return;
      stopAudio();
      mode = type;
      chosen = undefined;
      drawPattern();
      warmVoice();
    };
  }
  $('patternClear').onclick = () => {
    stopAudio();
    patterns[mode].clear();
    chosen = undefined;
    drawPattern();
  };
  $('voice').onchange = () => {
    stopAudio();
    warmVoice();
    if (chosen) audition(chosen);
  };
  $('tempo').onchange = () => { stopAudio(); stepSeconds(); };
  $('patternPreview').onclick = async () => {
    if (preview) { stopAudio(); return; }
    stopAudio();
    pause();
    const request = previewRequest;
    try {
      const events = [...patterns[mode].values()].map(event => ({...event}));
      const [, buffer] = await Promise.all([context.resume(), renderEvents(events, stepSeconds(), true, $('voice').value)]);
      if (request !== previewRequest) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (preview !== source) return;
        preview = undefined;
        updateControls();
      };
      source.start();
      preview = source;
      updateControls();
    } catch { say('Не удалось воспроизвести партию. Проверьте длину и доступность сэмплов.'); }
  };
  $('patternInsert').onclick = async () => {
    stopAudio();
    pause();
    const request = previewRequest;
    const at = position;
    try {
      const name = mode === 'drums' ? 'Бит' : $('voice').selectedOptions[0]?.textContent || 'Мелодия';
      const events = [...patterns[mode].values()].map(event => ({...event}));
      const buffer = await renderEvents(events, stepSeconds(), true, $('voice').value);
      if (request !== previewRequest) return;
      selected = addTrack(name, buffer, at);
      render();
      $('timeline').focus({preventScroll: true});
      say('На шкалу добавлен клип «' + name + '»');
    } catch (error) {
      say(error instanceof RangeError ? 'Партия слишком длинная для одного аудиоклипа' : 'Не удалось подготовить сэмплы партии');
    }
  };
  document.addEventListener('stop-pattern-preview', stopAudio);
  drawPattern();
}
