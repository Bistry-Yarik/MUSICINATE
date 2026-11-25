'use strict';

{
  const steps = 16;
  const drums = [
    {name: 'Бочка', voice: 'kick'},
    {name: 'Малый', voice: 'snare'},
    {name: 'Хай-хэт', voice: 'hat'},
    {name: 'Хлопок', voice: 'clap'}
  ];
  const melody = [
    {name: 'До 5', note: 72}, {name: 'Си 4', note: 71}, {name: 'Ля 4', note: 69},
    {name: 'Соль 4', note: 67}, {name: 'Фа 4', note: 65}, {name: 'Ми 4', note: 64},
    {name: 'Ре 4', note: 62}, {name: 'До 4', note: 60}
  ];
  const patterns = {drums, melody};
  for (const row of [...drums, ...melody]) row.cells = Array(steps).fill(false);
  let mode = 'drums';
  let preview, previewRequest = 0;

  function updateActions() {
    const hasNotes = patterns[mode].some(row => row.cells.includes(true));
    $('patternClear').disabled = !hasNotes;
    $('patternInsert').disabled = !hasNotes;
    $('patternPreview').disabled = !hasNotes && !preview;
    $('patternPreview').textContent = preview ? '■ Остановить' : '▶ Прослушать';
  }

  function drawPattern() {
    const grid = $('patternGrid');
    grid.dataset.mode = mode;
    grid.replaceChildren(make('span'));
    for (let step = 0; step < steps; step++) grid.append(make('span', 'step-number', String(step + 1)));
    for (const row of patterns[mode]) {
      grid.append(make('span', 'pattern-name', row.name));
      row.cells.forEach((enabled, step) => {
        const pad = make('button', 'step-pad' + (step % 4 === 0 ? ' group-start' : ''));
        pad.setAttribute('aria-label', row.name + ', шаг ' + (step + 1));
        pad.setAttribute('aria-pressed', enabled);
        pad.onclick = () => {
          stopPreview();
          row.cells[step] = !row.cells[step];
          pad.setAttribute('aria-pressed', row.cells[step]);
          updateActions();
        };
        grid.append(pad);
      });
    }
    $('drumsTab').setAttribute('aria-pressed', mode === 'drums');
    $('melodyTab').setAttribute('aria-pressed', mode === 'melody');
    updateActions();
  }

  function readTempo() {
    const bpm = Math.max(50, Math.min(220, Math.round($('tempo').valueAsNumber || 120)));
    $('tempo').value = bpm;
    return bpm;
  }

  function drumSample(voice, time, noise) {
    switch (voice) {
      case 'kick': {
        const phase = 43 * time + 3 * (1 - Math.exp(-time * 28));
        return .64 * Math.sin(2 * Math.PI * phase) * Math.exp(-time * 15);
      }
      case 'snare':
        return (.37 * noise + .13 * Math.sin(2 * Math.PI * 185 * time)) * Math.exp(-time * 23);
      case 'hat':
        return .21 * noise * Math.exp(-time * 55);
      case 'clap': {
        const burst = Math.exp(-time * 48) + (time >= .019 ? Math.exp(-(time - .019) * 34) : 0);
        return .23 * noise * burst;
      }
    }
  }

  function renderPattern() {
    const stepTime = 60 / readTempo() / 4;
    const buffer = context.createBuffer(1, Math.ceil(stepTime * steps * rate), rate);
    const samples = buffer.getChannelData(0);
    let seed = 19;
    for (const row of patterns[mode]) {
      row.cells.forEach((enabled, step) => {
        if (!enabled) return;
        const start = Math.round(step * stepTime * rate);
        const span = mode === 'melody' ? stepTime : .28;
        const frames = Math.min(samples.length - start, Math.ceil(span * rate));
        const frequency = 440 * 2 ** ((row.note - 69) / 12);
        for (let frame = 0; frame < frames; frame++) {
          const time = frame / rate;
          const edge = Math.min(1, time / .004, (frames - frame) / (rate * .025));
          let sample;
          if (mode === 'melody') {
            const phase = 2 * Math.PI * frequency * time;
            sample = .19 * (Math.sin(phase) + .23 * Math.sin(2 * phase) + .08 * Math.sin(3 * phase));
          } else {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            sample = drumSample(row.voice, time, seed / 2147483648 - 1);
          }
          samples[start + frame] += sample * edge;
        }
      });
    }
    const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), .95);
    if (peak > .95) {
      for (let frame = 0; frame < samples.length; frame++) samples[frame] *= .95 / peak;
    }
    return buffer;
  }

  function stopPreview() {
    previewRequest++;
    if (!preview) return;
    preview.stop();
    preview = undefined;
    updateActions();
  }

  $('sequencerToggle').onclick = () => {
    const open = $('sequencer').hidden;
    $('sequencer').hidden = !open;
    $('sequencerToggle').setAttribute('aria-expanded', open);
    if (!open) stopPreview();
    else $('sequencer').scrollIntoView({block: 'nearest'});
  };
  for (const [id, type] of [['drumsTab', 'drums'], ['melodyTab', 'melody']]) {
    $(id).onclick = () => {
      if (mode === type) return;
      stopPreview();
      mode = type;
      drawPattern();
    };
  }
  $('patternClear').onclick = () => {
    stopPreview();
    for (const row of patterns[mode]) row.cells.fill(false);
    drawPattern();
  };
  $('tempo').onchange = () => { stopPreview(); readTempo(); };
  $('patternPreview').onclick = async () => {
    if (preview) { stopPreview(); return; }
    pause();
    const request = ++previewRequest;
    try {
      await context.resume();
      if (request !== previewRequest) return;
      const source = context.createBufferSource();
      source.buffer = renderPattern();
      source.connect(context.destination);
      source.onended = () => {
        if (preview !== source) return;
        preview = undefined;
        updateActions();
      };
      source.start();
      preview = source;
      updateActions();
    } catch {
      say('Не удалось запустить прослушивание');
    }
  };
  $('patternInsert').onclick = () => {
    stopPreview();
    pause();
    const name = mode === 'drums' ? 'Бит' : 'Мелодия';
    selected = addTrack(name, renderPattern(), position);
    render();
    $('timeline').focus({preventScroll: true});
    say('На шкалу добавлен клип «' + name + '» · ' + format(position));
  };
  document.addEventListener('stop-pattern-preview', stopPreview);
  drawPattern();
}
