'use strict';

{
  const steps = 16;
  const drums = [
    {name: 'Бочка', voice: 'kick'},
    {name: 'Малый', voice: 'snare'},
    {name: 'Хай-хэт', voice: 'hat'},
    {name: 'Хлопок', voice: 'clap'},
    {name: 'Том', voice: 'tom'},
    {name: 'Шейкер', voice: 'shaker'},
    {name: 'Тарелка', voice: 'cymbal'}
  ];
  const melody = [
    {name: 'До 5', note: 72}, {name: 'Си 4', note: 71}, {name: 'Ля 4', note: 69},
    {name: 'Соль 4', note: 67}, {name: 'Фа 4', note: 65}, {name: 'Ми 4', note: 64},
    {name: 'Ре 4', note: 62}, {name: 'До 4', note: 60}
  ];
  const patterns = {drums, melody};
  for (const row of [...drums, ...melody]) row.cells = Array(steps).fill(false);
  const melodies = {
    synth: {gain: .19, decay: 0, attack: .004, harmonics: [[1, 1], [2, .23], [3, .08]]},
    piano: {gain: .23, decay: 6, attack: .003, harmonics: [[1, 1], [2, .39], [3, .18], [7, .05]]},
    bass: {gain: .3, decay: 4, attack: .006, harmonics: [[.5, 1], [1, .35], [1.5, .13]]},
    pluck: {gain: .32, decay: 18, attack: .002, harmonics: [[1, 1], [2, .47], [4, .34], [5, .17]]},
    organ: {gain: .22, decay: 0, attack: .018, harmonics: [[.5, .28], [1, .73], [2, .46], [3, .22]]},
    bell: {gain: .26, decay: 9, attack: .002, harmonics: [[1, 1], [2.76, .33], [5.4, .21]]}
  };
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
    $('voiceLabel').hidden = mode !== 'melody';
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
      case 'tom': {
        const phase = 104 * time + 1.7 * (1 - Math.exp(-time * 18));
        return .48 * (Math.sin(2 * Math.PI * phase) + .19 * Math.sin(4 * Math.PI * phase)) * Math.exp(-time * 12);
      }
      case 'shaker': {
        const sweep = .23 + .77 * Math.sin(Math.PI * Math.min(1, time / .135)) ** 2;
        return .32 * noise * sweep * Math.exp(-time * 17);
      }
      case 'cymbal': {
        const carrier = Math.sin(2 * Math.PI * 3209 * time) * Math.sin(2 * Math.PI * 2399 * time);
        return (.18 * noise + .11 * carrier) * Math.exp(-time * 8);
      }
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
    const instrument = melodies[$('voice').value] ?? melodies.synth;
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
          const attack = mode === 'melody' ? instrument.attack : .004;
          const edge = Math.min(1, time / attack, (frames - frame) / (rate * .025));
          let sample;
          if (mode === 'melody') {
            const phase = 2 * Math.PI * frequency * time;
            let harmonicMix = 0;
            for (const [ratio, level] of instrument.harmonics) {
              harmonicMix += level * Math.sin(ratio * phase);
            }
            sample = harmonicMix * instrument.gain * Math.exp(-time * instrument.decay);
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
  $('voice').onchange = stopPreview;
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
    const name = mode === 'drums' ? 'Бит' : $('voice').selectedOptions[0]?.textContent || 'Мелодия';
    selected = addTrack(name, renderPattern(), position);
    render();
    $('timeline').focus({preventScroll: true});
    say('На шкалу добавлен клип «' + name + '» · ' + format(position));
  };
  document.addEventListener('stop-pattern-preview', stopPreview);
  drawPattern();
}
