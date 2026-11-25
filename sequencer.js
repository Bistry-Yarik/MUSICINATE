'use strict';

{
  const columnWidth = 34;
  const rowHeight = 33;
  const labelWidth = 84;
  const headerHeight = 27;
  const minimumColumns = 32;
  const viewRows = 12;
  const drums = ['Бочка', 'Малый', 'Хай-хэт', 'Хлопок', 'Том', 'Шейкер', 'Тарелка'];
  const pitches = ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'];
  const patterns = {drums: new Map(), melody: new Map()};
  const views = {
    drums: {left: 0, top: 0, width: minimumColumns},
    melody: {left: 0, top: 0, width: minimumColumns}
  };
  const auditioning = new Set();
  const lowestNote = -12;
  const highestNote = 131;
  let mode = 'drums';
  views.melody.top = (highestNote - 71) * rowHeight;
  let chosen, preview, previewRequest = 0;
  let visiblePads = [];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const cellKey = (row, step) => row + ':' + step;
  const noteName = note => pitches[((note % 12) + 12) % 12] + ' ' + (Math.floor(note / 12) - 1);
  const sampleCache = new Map();
  const sampleRelease = {drums: .16, grand: .24, piano: .19, bass: .13, pluck: .23, organ: .075, bell: .34};

  function nearestRoot(voice, note) {
    return Object.keys(instrumentSamples[voice]).map(Number).reduce((nearest, root) =>
      Math.abs(root - note) < Math.abs(nearest - note) ? root : nearest);
  }

  function loadSample(voice, root) {
    const key = voice + ':' + root;
    if (!sampleCache.has(key)) {
      const encoded = voice === 'drums' ? drumSamples[root] : instrumentSamples[voice][root];
      const data = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
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
    if (mode === 'drums') {
      Promise.all(drums.map((_, root) => loadSample('drums', root))).catch(() => {});
      return;
    }
    const voice = $('voice').value;
    const start = Math.max(lowestNote, highestNote - Math.floor(views.melody.top / rowHeight) - viewRows + 1);
    const roots = new Set([0, 4, 8, 11].map(semitone => nearestRoot(voice, start + semitone)));
    Promise.all([...roots].map(root => loadSample(voice, root))).catch(() => {});
  }

  function mixSample(event, voice, sample, root, left, right, start, gate) {
    const semitones = event.kind === 'drums' ? event.pitch : event.row + event.pitch - root;
    const tuning = 2 ** (semitones / 12) * sample.rate / rate;
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
    const pan = event.kind === 'drums'
      ? [0, 0, .22, -.13, -.22, .33, -.32][event.row]
      : (event.row % 7 - 3) * .035;
    const velocity = event.step % 4 === 0 ? 1 : .92;
    for (let i = 0; i < limit; i++) {
      let at = i * tuning;
      if (loop && at >= loopEnd) at = loopStart + crossfade + (at - loopEnd) % (loopEnd - loopStart - crossfade);
      if (at >= sample.left.length - 1) break;
      const blend = loop ? clamp((at - loopEnd + crossfade) / crossfade, 0, 1) : 0;
      const crossAt = loopStart + (at - loopEnd + crossfade);
      const read = channel => interpolate(channel, at) * (1 - blend) + (blend ? interpolate(channel, crossAt) * blend : 0);
      const edge = Math.min(1, i / (rate * .002), (left.length - start - i - 1) / (rate * .006));
      const envelope = edge * (1 - clamp((i - gate) / release, 0, 1)) ** 2;
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

  const patternLength = events => events.reduce((end, event) => Math.max(end, event.step + event.length), 0);

  async function renderEvents(events, stepTime, fullPattern, voice) {
    const instrument = events[0]?.kind === 'drums' ? 'drums' : voice;
    const tail = patternLength(events) * stepTime;
    const musicSeconds = fullPattern ? tail : tail + sampleRelease[instrument];
    const frameCount = Math.max(1, Math.ceil(musicSeconds * rate - 1e-8));
    // Avoid attempting a huge synchronous audio allocation from a mistyped duration.
    if (frameCount * 8 > 128 * 1024 * 1024) throw new RangeError('Pattern exceeds audio buffer budget');
    const roots = events.map(event => instrument === 'drums' ? event.row : nearestRoot(instrument, event.row + event.pitch));
    const samples = await Promise.all(roots.map(root => loadSample(instrument, root)));
    const buffer = context.createBuffer(2, frameCount, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (const [index, event] of events.entries()) {
      const start = Math.round(event.step * stepTime * rate);
      const length = Math.min(frameCount - start, Math.ceil(event.length * stepTime * rate));
      if (length > 0) mixSample(event, instrument, samples[index], roots[index], left, right, start, length);
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
    note.length = Math.max(note.length, (note.kind === 'drums' ? .36 : .22) / stepTime);
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
    const steps = patternLength([...patterns[mode].values()]);
    $('patternLength').textContent = 'Длина, шагов: ' + Number(steps.toFixed(3));
    const view = views[mode];
    view.width = Math.max(view.width, Math.ceil(steps) + 16);
    syncExtent();
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

  const scroll = $('patternScroll');
  let renderedView = '';
  const visibleColumns = () => Math.max(1, Math.floor(((scroll.clientWidth || 628) - labelWidth) / columnWidth));
  const visiblePitchOffset = top => clamp(Math.round(top / rowHeight), 0, highestNote - lowestNote - viewRows + 1);

  function syncExtent() {
    const view = views[mode];
    const isMelody = mode === 'melody';
    $('patternSpace').style.width = labelWidth + view.width * columnWidth + 'px';
    $('patternSpace').style.height = headerHeight + (isMelody ? highestNote - lowestNote + 1 : drums.length) * rowHeight + 'px';
    scroll.style.height = headerHeight + (isMelody ? viewRows : drums.length) * rowHeight + 16 + 'px';
  }

  function showView() {
    syncExtent();
    scroll.scrollLeft = views[mode].left;
    scroll.scrollTop = views[mode].top;
    renderedView = '';
    drawPattern();
    warmVoice();
  }

  function drawPattern(focusKey) {
    const grid = $('patternGrid');
    const view = views[mode];
    const offset = Math.floor(view.left / columnWidth);
    const isMelody = mode === 'melody';
    const lowOffset = visiblePitchOffset(view.top);
    const columns = visibleColumns();
    const rows = isMelody
      ? Array.from({length: viewRows}, (_, i) => highestNote - lowOffset - i).filter(row => row >= lowestNote)
      : drums.map((_, i) => i);
    const events = patterns[mode];
    grid.dataset.mode = mode;
    grid.style.gridTemplateColumns = labelWidth + 'px repeat(' + columns + ', ' + columnWidth + 'px)';
    grid.replaceChildren(make('span'));
    visiblePads = [];
    $('voiceLabel').hidden = !isMelody;
    renderedView = [mode, offset, lowOffset, columns].join(':');
    for (let column = 0; column < columns; column++) {
      grid.append(make('span', 'step-number', String(offset + column + 1)));
    }
    for (const row of rows) {
      const label = isMelody ? noteName(row) : drums[row];
      grid.append(make('span', 'pattern-name', label));
      for (let column = 0; column < columns; column++) {
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

  function onScroll() {
    const view = views[mode];
    view.left = scroll.scrollLeft;
    view.top = scroll.scrollTop;
    const columns = visibleColumns();
    const offset = Math.floor(view.left / columnWidth);
    const row = visiblePitchOffset(view.top);
    if (offset + columns + 4 >= view.width) {
      view.width = offset + columns + 16;
      syncExtent();
    }
    if (renderedView !== [mode, offset, row, columns].join(':')) drawPattern();
  }

  scroll.addEventListener('scroll', () => { if (scroll.clientWidth) onScroll(); });
  scroll.addEventListener('wheel', event => {
    if (event.shiftKey && event.deltaY && !event.deltaX) {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? columnWidth : 1;
      scroll.scrollLeft += event.deltaY * scale;
    }
  }, {passive: false});
  scroll.addEventListener('keydown', event => {
    const movements = {
      ArrowLeft: [-columnWidth, 0], ArrowRight: [columnWidth, 0],
      ArrowUp: [0, -rowHeight], ArrowDown: [0, rowHeight]
    };
    const shift = movements[event.key];
    if (!shift) return;
    event.preventDefault();
    scroll.focus({preventScroll: true});
    scroll.scrollLeft += shift[0];
    scroll.scrollTop += shift[1];
  });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (scroll.clientWidth) onScroll();
    }).observe(scroll);
  }

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
    else {
      showView();
      $('sequencer').scrollIntoView({block: 'nearest'});
    }
  };
  for (const [id, type] of [['drumsTab', 'drums'], ['melodyTab', 'melody']]) {
    $(id).onclick = () => {
      if (mode === type) return;
      stopAudio();
      mode = type;
      chosen = undefined;
      showView();
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
  showView();
}
