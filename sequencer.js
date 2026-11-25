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
  const frequency = note => 440 * 2 ** ((note - 69) / 12);

  function stepSeconds() {
    const input = $('tempo');
    const bpm = Number.isFinite(input.valueAsNumber) ? Math.round(input.valueAsNumber) : Number(input.defaultValue);
    const tempo = clamp(bpm, Number(input.min), Number(input.max));
    input.value = tempo;
    return 60 / tempo / 4;
  }

  function makeSampler(event, instrument) {
    let seed = (19 + event.row * 31 + event.step * 113) >>> 0;
    let previousNoise = 0;
    let coloredNoise = 0;
    const tuning = 2 ** (event.pitch / 12);
    const hz = event.kind === 'melody' ? frequency(event.row + event.pitch) : 0;
    const velocity = event.step % 4 === 0 ? 1 : .9 + (seed % 11) / 100;
    const partial = (ratio, time) => hz * ratio < rate * .47 ? sine(hz * ratio * time) : 0;

    return (time, duration) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed / 2147483648 - 1;
      const high = (noise - previousNoise) * .65;
      previousNoise = noise;
      coloredNoise += .22 * (noise - coloredNoise);
      const attack = instrument === 'organ' && hz ? .022 : .004;
      const edge = Math.min(1, time / attack, (duration - time) / Math.min(.037, duration / 2));
      let sample;
      if (event.kind === 'drums') {
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
      } else {
        const phase = hz * time;
        const knock = coloredNoise * Math.exp(-time * 110);
        switch (instrument) {
          case 'piano': {
            const tine = hz < rate * .1 ? sine(phase + .6 * partial(3.99, time) * Math.exp(-time * 13)) : partial(1, time);
            sample = .23 * (tine * Math.exp(-time * 3) + .28 * partial(2.005, time) * Math.exp(-time * 9) + .16 * knock);
            break;
          }
          case 'bass':
            sample = .34 * (partial(1, time) + .26 * partial(2, time) * Math.exp(-time * 6)
              + .15 * partial(3, time) * Math.exp(-time * 18) + .1 * knock) * Math.exp(-time * 2.9);
            break;
          case 'pluck':
            sample = .26 * (partial(1, time) * Math.exp(-time * 7) + .68 * partial(2.003, time) * Math.exp(-time * 15)
              + .45 * partial(3.012, time) * Math.exp(-time * 23) + .28 * partial(5.04, time) * Math.exp(-time * 42) + knock * .2);
            break;
          case 'organ':
            sample = .19 * (partial(1, time) + .51 * partial(2, time) + .26 * partial(3, time) + .13 * partial(4, time))
              * (.93 + .07 * sine(time * 5.4)) + .025 * knock;
            break;
          case 'bell':
            sample = .25 * (partial(1, time) * Math.exp(-time * 3.5) + .45 * partial(2.76, time) * Math.exp(-time * 9)
              + .27 * partial(5.43, time) * Math.exp(-time * 16) + .13 * partial(8.19, time) * Math.exp(-time * 22));
            break;
          default:
            sample = .18 * (partial(1, time) + .34 * partial(1.003, time)
              + .25 * partial(2, time) * Math.exp(-time * 4) + .1 * partial(3, time) * Math.exp(-time * 8));
        }
      }
      return sample * edge * velocity;
    };
  }

  function renderEvents(events, stepTime, fullPattern) {
    const tail = events.reduce((end, event) => Math.max(end, event.step + event.length), 0);
    const steps = fullPattern ? Math.ceil(tail / 4) * 4 : tail;
    const frameCount = Math.max(1, Math.ceil(steps * stepTime * rate));
    // Avoid attempting a huge synchronous audio allocation from a mistyped step number.
    if (frameCount * 8 > 128 * 1024 * 1024) throw new RangeError('Pattern exceeds audio buffer budget');
    const buffer = context.createBuffer(2, frameCount, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const instrument = $('voice').value;
    const reflection = Math.round(.019 * rate);
    for (const event of events) {
      const start = Math.round(event.step * stepTime * rate);
      const length = Math.min(frameCount - start, Math.ceil(event.length * stepTime * rate));
      const sample = makeSampler(event, instrument);
      const pan = event.kind === 'melody' ? (event.row % 7 - 3) * .045 : [0, 0, .22, -.13, -.22, .33, -.32][event.row];
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
    try {
      await context.resume();
      if (request !== previewRequest) return;
      const buffer = renderEvents([{...event, step: 0, length: Math.min(event.length, 8)}], stepSeconds(), false);
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
        pad.onkeydown = event => {
          if ((event.code === 'Delete' || event.code === 'Backspace') && events.has(key)) {
            event.preventDefault();
            events.delete(key);
            chosen = undefined;
            refreshPads();
          }
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
    if (chosen) audition(chosen);
  };
  $('tempo').onchange = () => { stopAudio(); stepSeconds(); };
  $('patternPreview').onclick = async () => {
    if (preview) { stopAudio(); return; }
    stopAudio();
    pause();
    const request = previewRequest;
    try {
      await context.resume();
      if (request !== previewRequest) return;
      const source = context.createBufferSource();
      source.buffer = renderEvents([...patterns[mode].values()], stepSeconds(), true);
      source.connect(context.destination);
      source.onended = () => {
        if (preview !== source) return;
        preview = undefined;
        updateControls();
      };
      source.start();
      preview = source;
      updateControls();
    } catch { say('Не удалось воспроизвести партию. Проверьте её длину.'); }
  };
  $('patternInsert').onclick = () => {
    stopAudio();
    pause();
    try {
      const name = mode === 'drums' ? 'Бит' : $('voice').selectedOptions[0]?.textContent || 'Мелодия';
      selected = addTrack(name, renderEvents([...patterns[mode].values()], stepSeconds(), true), position);
      render();
      $('timeline').focus({preventScroll: true});
      say('На шкалу добавлен клип «' + name + '»');
    } catch { say('Партия слишком длинная для одного аудиоклипа'); }
  };
  document.addEventListener('stop-pattern-preview', stopAudio);
  drawPattern();
}
